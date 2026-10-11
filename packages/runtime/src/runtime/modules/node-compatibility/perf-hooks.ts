/** `node:perf_hooks`: the platform's `performance` and its observer. */
export function createPerfHooksBuiltin(runtimeGlobal: typeof globalThis): unknown {
  const performance = runtimeGlobal.performance ?? {
    now: () => Date.now(),
    markResourceTiming: () => undefined
  };
  // A worker has the platform's observer, which sees `measure` and `mark`
  // entries as Node's does; where there is none, an observer that never fires.
  const PerformanceObserver = runtimeGlobal.PerformanceObserver ?? NeverFiringPerformanceObserver;
  installEventLoopUtilization(performance as Performance);
  const builtin = {
    performance,
    PerformanceObserver,
    createHistogram: (options?: HistogramOptions) => new RecordableHistogram(options),
    monitorEventLoopDelay: (options?: { readonly resolution?: number }) =>
      new IntervalHistogram(runtimeGlobal, performance, options?.resolution ?? 10),
    PerformanceObserverEntryList: runtimeGlobal.PerformanceObserverEntryList,
    PerformanceEntry: runtimeGlobal.PerformanceEntry,
    PerformanceMark: runtimeGlobal.PerformanceMark,
    PerformanceMeasure: runtimeGlobal.PerformanceMeasure
  };
  return { ...builtin, default: builtin };
}

class NeverFiringPerformanceObserver {
  static readonly supportedEntryTypes: readonly string[] = [];
  constructor(_callback: unknown) {}
  observe(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] {
    return [];
  }
}

/**
 * Names of a dedicated worker's global that Node's lacks and that only tell a
 * program it runs in a browser, which the runtime itself does not use once it
 * started. Code a program evaluates through a function constructor
 * (a dev server's module runner) reads the real global, so they are hidden
 * there too, not only in compiled modules' scope: Angular's server rendering
 * then schedules with timers, as under Node, instead of calling a
 * `requestAnimationFrame` that throws in a worker.
 */
const BROWSER_WORKER_ONLY_GLOBALS = [
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'WorkerGlobalScope',
  'DedicatedWorkerGlobalScope',
  'importScripts'
] as const;

/** Hides the browser-only names of a process worker's global; a program may still define them. */
export function hideBrowserWorkerGlobals(): void {
  for (const name of BROWSER_WORKER_ONLY_GLOBALS) {
    Object.defineProperty(globalThis, name, { configurable: true, enumerable: false, writable: true, value: undefined });
  }
}

/** Gives the platform `performance` of a process worker the `markResourceTiming` and `eventLoopUtilization` Node defines. */
export function installNodePerformanceCompatibility(): void {
  const performance = globalThis.performance as Performance & { markResourceTiming?: (...args: unknown[]) => void };
  installEventLoopUtilization(performance);
  if (typeof performance.markResourceTiming === 'function') return;
  Object.defineProperty(performance, 'markResourceTiming', {
    configurable: true,
    value: () => undefined
  });
}

type EventLoopUtilization = { readonly idle: number; readonly active: number; readonly utilization: number };

/**
 * `performance.eventLoopUtilization()`. A worker cannot see how long its loop
 * sat idle or ran, so it reports the elapsed time as idle: a utilization of 0,
 * which leaves a load check such as `@fastify/under-pressure`'s
 * `maxEventLoopUtilization` unmet instead of claiming a saturated loop.
 */
function installEventLoopUtilization(performance: Performance): void {
  if (typeof (performance as { eventLoopUtilization?: unknown }).eventLoopUtilization === 'function') return;
  Object.defineProperty(performance, 'eventLoopUtilization', {
    configurable: true,
    writable: true,
    value: (first?: EventLoopUtilization, second?: EventLoopUtilization): EventLoopUtilization => {
      const now = { idle: performance.now(), active: 0, utilization: 0 };
      const since = second ?? first;
      if (!since) return now;
      const end = second ? first! : now;
      const active = end.active - since.active;
      const idle = end.idle - since.idle;
      return { idle, active, utilization: active + idle > 0 ? active / (active + idle) : 0 };
    }
  });
}

type HistogramOptions = {
  readonly lowest?: number | bigint;
  readonly highest?: number | bigint;
  readonly figures?: number;
};

/** The magnitude below which an HDR histogram of 3 significant figures counts each value apart. */
const EXACT_MAGNITUDE = 11;

/**
 * The width of the bucket that counts `value`, as Node's HDR histogram (3
 * significant figures) has it: 1 below 2048, then doubling with each power
 * of two, so a bucket is at most 1/1024 of its values.
 */
function bucketWidth(value: number): number {
  const magnitude = Math.floor(Math.log2(value)) + 1;
  return magnitude <= EXACT_MAGNITUDE ? 1 : 2 ** (magnitude - EXACT_MAGNITUDE);
}

function lowestEquivalent(value: number): number {
  const width = bucketWidth(value);
  return Math.floor(value / width) * width;
}

function highestEquivalent(value: number): number {
  return lowestEquivalent(value) + bucketWidth(value) - 1;
}

/**
 * Node's `Histogram`: values in nanoseconds counted in the buckets of an HDR
 * histogram, so its size depends on the range of the values and not on how
 * many were recorded, with the statistics Node derives from those buckets.
 */
class Histogram {
  /** Counts by the lowest value of their bucket. */
  #buckets = new Map<number, number>();
  #ordered: Array<[number, number]> | undefined = [];
  #count = 0;
  #min = Number.POSITIVE_INFINITY;
  #max = 0;
  #exceeds = 0;
  readonly #highest: number;

  constructor(options: HistogramOptions = {}) {
    this.#highest = Number(options.highest ?? Number.MAX_SAFE_INTEGER);
  }

  protected recordValue(value: number, times = 1): void {
    if (value > this.#highest) {
      this.#exceeds += times;
      return;
    }
    const bucket = lowestEquivalent(value);
    const previous = this.#buckets.get(bucket);
    this.#buckets.set(bucket, (previous ?? 0) + times);
    if (previous === undefined) this.#ordered = undefined;
    this.#count += times;
    if (value < this.#min) this.#min = value;
    if (value > this.#max) this.#max = value;
  }

  /** Adds what `other` counted, for `RecordableHistogram.add`. */
  protected addCounts(other: Histogram): void {
    for (const [bucket, count] of other.#buckets) this.recordValue(bucket, count);
    if (other.#count > 0) {
      this.#min = Math.min(this.#min, other.#min);
      this.#max = Math.max(this.#max, other.#max);
    }
    this.#exceeds += other.#exceeds;
  }

  /** The buckets in order of their values, with their counts. */
  #sorted(): Array<[number, number]> {
    this.#ordered ??= [...this.#buckets].sort(([left], [right]) => left - right);
    return this.#ordered;
  }

  get count(): number {
    return this.#count;
  }

  get countBigInt(): bigint {
    return BigInt(this.count);
  }

  get min(): number {
    return this.count === 0 ? 9223372036854776000 : lowestEquivalent(this.#min);
  }

  get minBigInt(): bigint {
    return BigInt(Math.round(this.min));
  }

  get max(): number {
    return this.count === 0 ? 0 : highestEquivalent(this.#max);
  }

  get maxBigInt(): bigint {
    return BigInt(Math.round(this.max));
  }

  /** Each bucket counts as the middle of its values, as in Node. */
  get mean(): number {
    if (this.count === 0) return Number.NaN;
    let total = 0;
    for (const [bucket, count] of this.#buckets) total += count * (bucket + Math.floor(bucketWidth(bucket) / 2));
    return total / this.count;
  }

  get stddev(): number {
    if (this.count === 0) return Number.NaN;
    const mean = this.mean;
    let total = 0;
    for (const [bucket, count] of this.#buckets) {
      total += count * (bucket + Math.floor(bucketWidth(bucket) / 2) - mean) ** 2;
    }
    return Math.sqrt(total / this.count);
  }

  get exceeds(): number {
    return this.#exceeds;
  }

  get exceedsBigInt(): bigint {
    return BigInt(this.#exceeds);
  }

  percentile(percentile: number): number {
    if (!(percentile > 0 && percentile <= 100)) {
      throw new RangeError(`The value of "percentile" is out of range. It must be > 0 && <= 100. Received ${percentile}`);
    }
    if (this.count === 0) return 0;
    const wanted = Math.max(1, Math.floor((percentile / 100) * this.count + 0.5));
    let seen = 0;
    for (const [bucket, count] of this.#sorted()) {
      seen += count;
      if (seen >= wanted) return highestEquivalent(bucket);
    }
    return this.max;
  }

  percentileBigInt(percentile: number): bigint {
    return BigInt(Math.round(this.percentile(percentile)));
  }

  /**
   * Node's percentile iteration: 0, 50, 75, 87.5, … each halving the
   * distance to 100, reported at the first bucket that reaches it, until
   * every value was counted, then 100.
   */
  get percentiles(): Map<number, number> {
    const percentiles = new Map<number, number>();
    let next = 0;
    let seen = 0;
    let value = 0;
    for (const [bucket, count] of this.#sorted()) {
      seen += count;
      value = bucket;
      while (next <= (100 * seen) / this.count) {
        percentiles.set(next, bucket);
        next += 100 / 2 ** (Math.floor(Math.log2(100 / (100 - next))) + 1);
        if (seen >= this.count) break;
      }
      if (seen >= this.count) break;
    }
    percentiles.set(100, value);
    return percentiles;
  }

  get percentilesBigInt(): Map<number, bigint> {
    return new Map([...this.percentiles].map(([key, value]) => [key, BigInt(Math.round(value))]));
  }

  reset(): void {
    this.#buckets = new Map();
    this.#ordered = [];
    this.#count = 0;
    this.#min = Number.POSITIVE_INFINITY;
    this.#max = 0;
    this.#exceeds = 0;
  }

  toJSON(): object {
    return {
      count: this.count,
      min: this.min,
      max: this.max,
      mean: this.mean,
      exceeds: this.exceeds,
      stddev: this.stddev,
      percentiles: Object.fromEntries(this.percentiles)
    };
  }
}

class RecordableHistogram extends Histogram {
  #previous: number | undefined;

  record(value: number | bigint): void {
    const recorded = Number(value);
    if (!Number.isInteger(recorded) || recorded < 1) {
      throw new RangeError(`The value of "val" is out of range. It must be >= 1. Received ${String(value)}`);
    }
    this.recordValue(recorded);
  }

  recordDelta(): void {
    const now = performance.now();
    if (this.#previous !== undefined) this.recordValue(Math.max(1, Math.round((now - this.#previous) * 1e6)));
    this.#previous = now;
  }

  add(other: RecordableHistogram): void {
    this.addCounts(other);
  }
}

/**
 * `monitorEventLoopDelay()`: a timer every `resolution` milliseconds records
 * the time since its previous run, as Node's does, so a loop that never waits
 * records about `resolution` and consumers subtract it. The timer is
 * unreferenced, so monitoring never keeps a program alive, as in Node.
 */
class IntervalHistogram extends Histogram {
  #timer: { unref?(): unknown } | number | undefined;
  readonly #resolution: number;
  readonly #runtimeGlobal: typeof globalThis;
  readonly #clock: { now(): number };

  constructor(runtimeGlobal: typeof globalThis, clock: { now(): number }, resolution: number) {
    super();
    this.#clock = clock;
    if (!(Number.isInteger(resolution) && resolution >= 1)) {
      throw new RangeError(`The value of "options.resolution" is out of range. It must be >= 1. Received ${resolution}`);
    }
    this.#runtimeGlobal = runtimeGlobal;
    this.#resolution = resolution;
  }

  enable(): boolean {
    if (this.#timer !== undefined) return false;
    // As in Node, the first run only starts the measurement.
    let previous: number | undefined;
    const timer = this.#runtimeGlobal.setInterval(() => {
      const now = this.#clock.now();
      if (previous !== undefined) this.recordValue(Math.max(1, Math.round((now - previous) * 1e6)));
      previous = now;
    }, this.#resolution) as unknown as { unref?(): unknown } | number;
    if (typeof timer === 'object') timer.unref?.();
    this.#timer = timer;
    return true;
  }

  disable(): boolean {
    if (this.#timer === undefined) return false;
    this.#runtimeGlobal.clearInterval(this.#timer as Parameters<typeof clearInterval>[0]);
    this.#timer = undefined;
    return true;
  }
}
