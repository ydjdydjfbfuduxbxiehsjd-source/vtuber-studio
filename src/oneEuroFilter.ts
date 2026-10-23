/**
 * 1€ Filter (One Euro Filter)
 * Reference: Casiez, G., Roussel, N. and Vogel, D. (2012)
 * "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems"
 * ACM CHI 2012.
 */

function alpha(dt: number, cutoff: number): number {
  const tau = 1.0 / (2.0 * Math.PI * cutoff);
  return 1.0 / (1.0 + tau / dt);
}

export class LowPassFilter {
  private y: number | null = null;
  private s: number | null = null;

  filter(x: number, alphaVal: number): number {
    if (this.y === null) {
      this.s = x;
      this.y = x;
      return x;
    }
    this.y = alphaVal * x + (1.0 - alphaVal) * this.s!;
    this.s = this.y;
    return this.y;
  }

  hasLastRawValue(): boolean {
    return this.y !== null;
  }

  lastRawValue(): number {
    return this.y ?? 0;
  }

  reset(): void {
    this.y = null;
    this.s = null;
  }
}

export class OneEuroFilter {
  minCutoff: number;
  beta: number;
  dCutoff: number;

  private xFilter: LowPassFilter = new LowPassFilter();
  private dxFilter: LowPassFilter = new LowPassFilter();
  private lastTime: number | null = null;

  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  filter(x: number, timestamp: number): number {
    if (this.lastTime === null) {
      this.lastTime = timestamp;
      return this.xFilter.filter(x, 1.0);
    }

    // Convert ms timestamp to seconds
    const dt = Math.max((timestamp - this.lastTime) / 1000.0, 1e-4);
    this.lastTime = timestamp;

    // Estimate derivative (velocity)
    const prevX = this.xFilter.lastRawValue();
    const dx = (x - prevX) / dt;
    const edx = this.dxFilter.filter(dx, alpha(dt, this.dCutoff));

    // Dynamic cutoff frequency
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilter.filter(x, alpha(dt, cutoff));
  }

  reset(): void {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTime = null;
  }
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export class OneEuroFilter3D {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  private fz: OneEuroFilter;

  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fz = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  filter(v: Vec3Like, timestamp: number): Vec3Like {
    return {
      x: this.fx.filter(v.x, timestamp),
      y: this.fy.filter(v.y, timestamp),
      z: this.fz.filter(v.z, timestamp),
    };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }
}
