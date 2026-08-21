import ComputeLayer from '@websr/websr/src/layers/base_compute_layer';
import type { LayerWeights } from './bin-weights';

/** Weights arrive as Float32Array from .bin and as plain arrays from JSON. */
const floats = (values: ArrayLike<number>) =>
  values instanceof Float32Array ? values : new Float32Array(values);

/**
 * Width-generic replacements for WebSR's hardcoded conv layers.
 *
 * WebSR ships one class per channel width (conv2d-16x4, conv2d-56x4, …), which
 * only covers the 8-channel network. The 16- and 28-channel networks need other
 * widths, so these take the width as a parameter instead.
 *
 * Each stage of the network holds `width` buffers of 4 channels. Activations use
 * CReLU, i.e. max(v, 0) and max(-v, 0) are fed through separate kernels, which is
 * why every weight count comes out at twice what a plain ReLU would need.
 */

const TAPS = 9; // 3x3
const KERNEL_OFFSETS = new Float32Array([
  -1, -1, 0, 0,
  -1, 0, 0, 0,
  -1, 1, 0, 0,
  0, -1, 0, 0,
  0, 0, 0, 0,
  0, 1, 0, 0,
  1, -1, 0, 0,
  1, 0, 0, 0,
  1, 1, 0, 0,
]);

/**
 * 3x3 convolution over `width` input buffers.
 *
 * Kernel layout is 9 taps per block, blocks ordered [positive buffers…,
 * negative buffers…], giving 18 * width matrices in total.
 */
export class GenericConv3x3 extends ComputeLayer {
  label = 'GenericConv3x3';

  constructor(inputs: GPUBuffer[], outputBuffer: GPUBuffer, weights: LayerWeights, width: number) {
    super(inputs, outputBuffer, weights);

    const matrices = TAPS * 2 * width;
    const expected = matrices * 16;
    if (weights.weights.length !== expected) {
      throw new Error(
        `Conv3x3 width ${width} expects ${expected} weights, got ${weights.weights.length}.`,
      );
    }

    this.createUniform('kernel_offsets', `array<vec4f, ${TAPS}>`);
    this.createUniform('kernels', `array<mat4x4f, ${matrices}>`);
    this.createUniform('bias', 'vec4f');

    let accumulate = '';
    for (let b = 0; b < width; b++) {
      accumulate += `
        let v${b} = inputBuffer${b}[buff_ind];
        result += kernels[tap + ${b * TAPS}u]*max(v${b}, vec4f(0.0));
        result += kernels[tap + ${(width + b) * TAPS}u]*max(-1.0*v${b}, vec4f(0.0));`;
    }

    this.shader = this.createStandardShader(`
      @compute @workgroup_size(${this.num_work_groups}, ${this.num_work_groups})
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let coord = vec2<i32>(i32(id.x), i32(id.y));
        var result = vec4f(0.0, 0.0, 0.0, 0.0);

        for (var tap = 0u; tap < ${TAPS}u; tap++) {
          let loc = coord + vec2<i32>(kernel_offsets[tap].xy);
          let buff_ind = loc.y*${this.resolution.width} + loc.x;
          ${accumulate}
        }

        result += bias;
        outputBuffer[coord.y*${this.resolution.width} + coord.x] = result;
      }
    `);

    this.setUniform('kernel_offsets', KERNEL_OFFSETS);
    this.setUniform('kernels', floats(weights.weights));
    this.setUniform('bias', floats(weights.bias));

    this.defaultSetup();
  }
}

/**
 * One pass of the final 1x1 convolution.
 *
 * The full layer reads every stage of the network at once — `stages * width`
 * buffers — which blows past the per-shader storage buffer limit. It is instead
 * split into `width` passes of `stages` buffers each, summed afterwards by
 * {@link GenericSum}. Pass `p` picks the matrices belonging to buffer index `p`.
 */
export class GenericConv1x1Pass extends ComputeLayer {
  label = 'GenericConv1x1Pass';

  constructor(
    inputs: GPUBuffer[],
    outputBuffer: GPUBuffer,
    weights: LayerWeights,
    width: number,
    pass: number,
  ) {
    super(inputs, outputBuffer, weights);

    const stages = inputs.length;
    const matrices = stages * 2 * width;
    if (weights.weights.length !== matrices * 16) {
      throw new Error(
        `Conv1x1 width ${width} expects ${matrices * 16} weights, got ${weights.weights.length}.`,
      );
    }

    this.createUniform('kernels', `array<mat4x4f, ${matrices}>`);

    let accumulate = '';
    for (let s = 0; s < stages; s++) {
      const positive = 2 * width * s + pass;
      const negative = 2 * width * s + width + pass;
      accumulate += `
        let v${s} = inputBuffer${s}[buff_ind];
        result += kernels[${positive}]*max(v${s}, vec4f(0.0));
        result += kernels[${negative}]*max(-1.0*v${s}, vec4f(0.0));`;
    }

    this.shader = this.createStandardShader(`
      @compute @workgroup_size(${this.num_work_groups}, ${this.num_work_groups})
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let buff_ind = i32(id.y)*${this.resolution.width} + i32(id.x);
        var result = vec4f(0.0, 0.0, 0.0, 0.0);
        ${accumulate}
        outputBuffer[buff_ind] = result;
      }
    `);

    this.setUniform('kernels', floats(weights.weights));
    this.defaultSetup();
  }
}

/** Adds the partial passes back together and applies the layer bias. */
export class GenericSum extends ComputeLayer {
  label = 'GenericSum';

  constructor(inputs: GPUBuffer[], outputBuffer: GPUBuffer, weights: LayerWeights) {
    super(inputs, outputBuffer, weights);

    this.createUniform('bias', 'vec4f');

    const terms = inputs.map((_, i) => `inputBuffer${i}[buff_ind]`).join(' + ');

    this.shader = this.createStandardShader(`
      @compute @workgroup_size(${this.num_work_groups}, ${this.num_work_groups})
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let buff_ind = i32(id.y)*${this.resolution.width} + i32(id.x);
        outputBuffer[buff_ind] = ${terms} + bias;
      }
    `);

    this.setUniform('bias', floats(weights.bias));
    this.defaultSetup();
  }
}
