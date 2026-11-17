// Telemetry (v3 Phase 2, docs/adr/0013): OpenTelemetry traces and metrics for requests, scheduled jobs and Claude calls,
// with an allowlist of attributes. Nothing derived from a request's URL, query, headers or body, a user, a health value,
// a prompt or a response can be recorded: every attribute goes through clean(), which keeps only the keys in ALLOWED and
// only values that pass that key's check (strict, in tests, throws instead of dropping). The metrics views apply the same
// allowlist again, so a mistake in one layer is caught by the other.
//
// Where it goes (TELEMETRY, owner's choice 2026-11-17): log (the default) keeps it on the server: a [trace] line for a
// slow or failed request and a [telemetry] summary every 15 minutes, in the app's logs. off records nothing. A later
// step adds otlp, an OpenTelemetry collector sending to the owner's AWS CloudWatch: one exporter here, nothing else.
import { SpanStatusCode, type Attributes, type Counter, type Histogram, type Tracer } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan, type SpanExporter,
} from '@opentelemetry/sdk-trace';
import {
  AggregationTemporality, DataPointType, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader,
  createAllowListAttributesProcessor, type MetricReader, type PushMetricExporter, type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
// A route template (/api/days/:date), the static files' /*, or unmatched; never a filled-in URL.
const ROUTE = /^(\/[A-Za-z0-9_.:*-]*)+$/;
const JOBS = new Set(['sync', 'review', 'backup', 'restore-test']);
const AI = new Set(['review', 'advisor-chat', 'help-ask', 'prompt-draft', 'program-extract', 'other']);

/** The only attributes telemetry may carry, each with the check its value must pass. */
export const ALLOWED: Record<string, (v: unknown) => boolean> = {
  'http.request.method': (v) => typeof v === 'string' && METHODS.has(v),
  'http.route': (v) => v === 'unmatched' || (typeof v === 'string' && v.length <= 100 && ROUTE.test(v)),
  'http.response.status_code': (v) => Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 599,
  'job.name': (v) => typeof v === 'string' && JOBS.has(v),
  'job.result': (v) => v === 'ok' || v === 'failed',
  'db.engine': (v) => v === 'sqlite' || v === 'postgres',
  'app.instance': (v) => v === 'main' || v === 'demo',
  'ai.capability': (v) => typeof v === 'string' && AI.has(v),
  'ai.outcome': (v) => v === 'ok' || v === 'refused' || v === 'error',
};
const ALLOWED_KEYS = Object.keys(ALLOWED);

export class TelemetryAttributeError extends Error {
  constructor(key: string) {
    super(`Telemetry attribute not allowed: ${key}`); // the key only, never the value
    this.name = 'TelemetryAttributeError';
  }
}

/** The attributes that may be recorded: unknown keys and values that fail their check are dropped (thrown when strict). */
export function clean(attrs: Record<string, unknown>, strict = false): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    const check = Object.hasOwn(ALLOWED, key) ? ALLOWED[key] : undefined;
    if (check && check(value)) out[key] = value as string | number;
    else if (strict) throw new TelemetryAttributeError(key);
  }
  return out;
}

export interface Telemetry {
  /** One finished request: its method, its route template (null when no route matched), status and duration. */
  request(method: string, route: string | null | undefined, status: number, ms: number): void;
  /** One scheduled job run. */
  job(name: string, result: 'ok' | 'failed', ms: number): void;
  /** One Claude call, by the run it belongs to. */
  ai(runName: string, outcome: 'ok' | 'refused' | 'error', ms: number): void;
  /** Exports what is pending (the metrics summary too). */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

interface Log {
  info?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface TelemetryOptions {
  /** log (default), off; otlp comes with the CloudWatch step. */
  mode?: string;
  instance?: 'main' | 'demo';
  log?: Log;
  /** Tests: throw on an attribute that is not allowed, instead of dropping it. */
  strict?: boolean;
  /** Tests: where spans go instead of the log (an InMemorySpanExporter). */
  spanExporter?: SpanExporter;
  /** Tests: where metrics go instead of the 15-minute log summary. */
  metricReader?: MetricReader;
  /** How often the log summary is written (ms). */
  summaryEveryMs?: number;
}

const SLOW_MS = 1000;
const SUMMARY_EVERY_MS = 15 * 60 * 1000;
const success = { code: 0 }; // ExportResultCode.SUCCESS

/** [trace] lines for slow or failed requests only: method, route template, status and duration. */
class LogSpanExporter implements SpanExporter {
  private readonly log: Log;
  constructor(log: Log) { this.log = log; }
  export(spans: ReadableSpan[], done: Parameters<SpanExporter['export']>[1]): void {
    for (const s of spans) {
      const status = Number(s.attributes['http.response.status_code'] ?? 0);
      const ms = Math.round(s.duration[0] * 1000 + s.duration[1] / 1e6);
      // A request: when slow or a server error. A job or Claude call (they take longer by nature): only when it failed.
      const isRequest = 'http.route' in s.attributes;
      if (s.status.code === SpanStatusCode.ERROR || (isRequest && (status >= 500 || ms > SLOW_MS))) {
        this.log.warn?.(`[trace] ${s.name} ${status || s.attributes['job.result'] || ''} ${ms}ms`.replace(/\s+/g, ' '));
      }
    }
    done(success as Parameters<typeof done>[0]);
  }
  async shutdown(): Promise<void> {}
}

/** The [telemetry] summary: requests by route (count, errors, average and longest ms), jobs and Claude calls by outcome. */
class LogMetricExporter implements PushMetricExporter {
  private readonly log: Log;
  constructor(log: Log) { this.log = log; }
  export(metrics: ResourceMetrics, done: Parameters<PushMetricExporter['export']>[1]): void {
    const lines = summarize(metrics);
    if (lines) this.log.info?.(`[telemetry] ${lines}`);
    done(success as Parameters<typeof done>[0]);
  }
  selectAggregationTemporality(): AggregationTemporality { return AggregationTemporality.DELTA; }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/** One summary line from a collection: names and numbers only. */
export function summarize(metrics: ResourceMetrics): string {
  const routes = new Map<string, { n: number, errors: number, sum: number, max: number }>();
  const counts: string[] = [];
  for (const scope of metrics.scopeMetrics) {
    for (const m of scope.metrics) {
      if (m.dataPointType === DataPointType.HISTOGRAM && m.descriptor.name === 'http.server.request.duration') {
        for (const p of m.dataPoints) {
          const key = `${p.attributes['http.request.method']} ${p.attributes['http.route']}`;
          const r = routes.get(key) ?? { n: 0, errors: 0, sum: 0, max: 0 };
          r.n += p.value.count;
          r.sum += p.value.sum ?? 0;
          r.max = Math.max(r.max, p.value.max ?? 0);
          if (Number(p.attributes['http.response.status_code']) >= 500) r.errors += p.value.count;
          routes.set(key, r);
        }
      } else if (m.dataPointType === DataPointType.SUM && (m.descriptor.name === 'job.runs' || m.descriptor.name === 'ai.calls')) {
        for (const p of m.dataPoints) {
          const what = m.descriptor.name === 'job.runs'
            ? `job ${p.attributes['job.name']} ${p.attributes['job.result']}`
            : `ai ${p.attributes['ai.capability']} ${p.attributes['ai.outcome']}`;
          if (p.value) counts.push(`${what} ${p.value}`);
        }
      }
    }
  }
  const total = [...routes.values()].reduce((a, r) => a + r.n, 0);
  if (!total && !counts.length) return '';
  const errors = [...routes.values()].reduce((a, r) => a + r.errors, 0);
  const top = [...routes].sort((a, b) => b[1].n - a[1].n).slice(0, 10)
    .map(([k, r]) => `${k} ${r.n} avg ${Math.round(r.sum / r.n)}ms max ${Math.round(r.max)}ms${r.errors ? ` errors ${r.errors}` : ''}`);
  return [`requests ${total} errors ${errors}`, ...top, ...counts].join('; ');
}

/** The telemetry for one process. mode off (or no providers) records nothing. */
export function createTelemetry({
  mode = process.env.TELEMETRY || 'log', instance = 'main', log = console, strict = false, spanExporter, metricReader,
  summaryEveryMs = SUMMARY_EVERY_MS,
}: TelemetryOptions = {}): Telemetry {
  if (mode === 'off') return noTelemetry;
  if (mode !== 'log') throw new Error(`TELEMETRY must be log or off (got ${mode})`);
  const resource = resourceFromAttributes({ 'service.name': 'health-review', ...clean({ 'app.instance': instance }, strict) });
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter ?? new LogSpanExporter(log) })],
  });
  const reader = metricReader ?? new PeriodicExportingMetricReader({
    exporter: new LogMetricExporter(log), exportIntervalMillis: summaryEveryMs, exportTimeoutMillis: 30_000,
  });
  // The allowlist again, on every instrument: an attribute that slipped past clean() still never reaches a metric.
  const meterProvider = new MeterProvider({
    resource,
    readers: [reader],
    views: [{ instrumentName: '*', attributesProcessors: [createAllowListAttributesProcessor(ALLOWED_KEYS)] }],
  });
  const tracer: Tracer = tracerProvider.getTracer('health-review');
  const meter = meterProvider.getMeter('health-review');
  const requests: Histogram = meter.createHistogram('http.server.request.duration', { unit: 'ms' });
  const jobs: Counter = meter.createCounter('job.runs');
  const jobTime: Histogram = meter.createHistogram('job.duration', { unit: 'ms' });
  const aiCalls: Counter = meter.createCounter('ai.calls');
  const aiTime: Histogram = meter.createHistogram('ai.duration', { unit: 'ms' });

  /** A span for something that already finished, ms long, ending now. */
  const finished = (name: string, attrs: Attributes, ms: number, failed: boolean) => {
    const end = Date.now();
    const span = tracer.startSpan(name, { startTime: end - ms, attributes: attrs });
    if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end(end);
  };

  return {
    request(method, route, status, ms) {
      const attrs = clean({ 'http.request.method': method, 'http.route': route ?? 'unmatched', 'http.response.status_code': status }, strict);
      requests.record(ms, attrs);
      finished(`${attrs['http.request.method'] ?? 'request'} ${attrs['http.route'] ?? 'unmatched'}`, attrs, ms, status >= 500);
    },
    job(name, result, ms) {
      const attrs = clean({ 'job.name': name, 'job.result': result }, strict);
      jobs.add(1, attrs);
      jobTime.record(ms, attrs);
      finished(`job ${attrs['job.name'] ?? 'other'}`, attrs, ms, result === 'failed');
    },
    ai(runName, outcome, ms) {
      const attrs = clean({ 'ai.capability': AI.has(runName) ? runName : 'other', 'ai.outcome': outcome }, strict);
      aiCalls.add(1, attrs);
      aiTime.record(ms, attrs);
      finished(`ai ${attrs['ai.capability']}`, attrs, ms, outcome === 'error');
    },
    async flush() {
      await tracerProvider.forceFlush();
      await meterProvider.forceFlush();
    },
    async shutdown() {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    },
  };
}

const noTelemetry: Telemetry = {
  request() {}, job() {}, ai() {}, async flush() {}, async shutdown() {},
};

// The process's telemetry: the server installs one at start; until then (scripts, most tests) nothing is recorded.
let current: Telemetry = noTelemetry;
export const telemetry = (): Telemetry => current;
export function installTelemetry(t: Telemetry | null): void {
  current = t ?? noTelemetry;
}

export { InMemoryMetricExporter, InMemorySpanExporter };
