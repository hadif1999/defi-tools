import { randomUUID } from 'node:crypto';

// Background jobs for slow tasks the dashboard starts (candle downloads, alert checks): each has an ID, a status, a
// progress line and its notes, and the result when it finishes. Listeners (the event stream) hear every change.

export type JobStatus = 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  progress?: string;
  notes: string[];
  result?: unknown;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface JobIo { progress: (text: string) => void; note: (text: string) => void }

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Set<(job: Job) => void>();

  constructor(private readonly keep = 50) {}

  onChange(listener: (job: Job) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start a job; returns at once with the job, which runs in the background. */
  start(kind: string, label: string, task: (io: JobIo) => Promise<unknown>): Job {
    const job: Job = { id: randomUUID(), kind, label, status: 'running', notes: [], startedAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    this.trim();
    this.emit(job);
    let lastProgress = 0;
    const io: JobIo = {
      // Progress lines can arrive many times a second; pass at most a few a second on.
      progress: (text) => {
        job.progress = text.trim() || undefined;
        const now = Date.now();
        if (now - lastProgress > 250 || !text) { lastProgress = now; this.emit(job); }
      },
      note: (text) => { job.notes.push(text.trim()); this.emit(job); },
    };
    void task(io).then((result) => {
      job.status = 'done';
      job.result = result;
    }, (error: unknown) => {
      job.status = 'failed';
      job.error = (error as Error)?.message ?? String(error);
    }).finally(() => {
      job.finishedAt = new Date().toISOString();
      job.progress = undefined;
      this.emit(job);
    });
    return job;
  }

  get(id: string): Job | undefined { return this.jobs.get(id); }

  /** Newest first. */
  list(): Job[] { return [...this.jobs.values()].reverse(); }

  get running(): number { return [...this.jobs.values()].filter((job) => job.status === 'running').length; }

  private emit(job: Job): void { for (const listener of this.listeners) listener(job); }

  private trim(): void {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.keep) break;
      if (job.status !== 'running') this.jobs.delete(id);
    }
  }
}

/** A job without its (possibly large) result, for lists and events. */
export const jobSummary = ({ result, ...job }: Job): Omit<Job, 'result'> & { hasResult: boolean } => ({ ...job, hasResult: result !== undefined });
