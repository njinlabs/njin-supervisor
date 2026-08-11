import type { WorkerResponseMessage } from "@njinlabs/njin/worker";

export type PendingRequest = {
  resolve: (response: WorkerResponseMessage) => void;
  reject: (error: Error) => void;
  timer: Timer;
};

export type WorkerHandle = {
  worker: Worker;
  ready: boolean;
  inFlight: number;
  // Resolves once the "ready" postMessage arrives, rejects if the worker dies before that —
  // lets dispatch() await boot instead of failing a request just because it raced spawn().
  readyPromise: Promise<void>;
};

export type SupervisorOptions = {
  port: number;
};
