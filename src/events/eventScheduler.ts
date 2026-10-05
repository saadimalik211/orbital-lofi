import type { WorldEvent, WorldEventType } from "@/worlds/types";

const RETRY_MS = 15_000;

const DEFAULT_DURATION: Record<WorldEventType, number> = {
  flyby: 9_000,
  streak: 1_400,
  pulse: 1_600,
  sound: 8_000,
};

type Random = () => number;

export function pickWeighted<T extends { weight: number }>(
  items: readonly T[],
  random: Random = Math.random,
): T | null {
  let total = 0;
  for (const item of items) {
    total += Math.max(0, item.weight);
  }
  if (total <= 0) {
    return null;
  }

  let roll = random() * total;
  for (const item of items) {
    const weight = Math.max(0, item.weight);
    if (roll < weight) {
      return item;
    }
    roll -= weight;
  }
  return null;
}

export function randomBetween(min: number, max: number, random: Random = Math.random) {
  const low = Math.min(min, max);
  return low + random() * Math.abs(max - min);
}

export function eventDuration(event: WorldEvent) {
  return event.duration ?? DEFAULT_DURATION[event.type];
}

type SchedulerOptions = {
  events: readonly WorldEvent[];
  canRun: (event: WorldEvent) => boolean;
  onStart: (event: WorldEvent) => void;
  onEnd: (event: WorldEvent) => void;
  now?: () => number;
  random?: Random;
};

export function createEventScheduler({
  events,
  canRun,
  onStart,
  onEnd,
  now = () => performance.now(),
  random = Math.random,
}: SchedulerOptions) {
  let timer = 0;
  let active: WorldEvent | null = null;
  let lastId: string | null = null;
  let disposed = false;
  const lastEndedAt = new Map<string, number>();

  const coolingDown = (event: WorldEvent) => {
    const ended = lastEndedAt.get(event.id);
    return ended !== undefined && now() - ended < (event.cooldown ?? 0);
  };

  const eligible = () => {
    const ready = events.filter((event) => canRun(event) && !coolingDown(event));
    return ready.length > 1 ? ready.filter((event) => event.id !== lastId) : ready;
  };

  const finish = (scheduleAfter: boolean) => {
    window.clearTimeout(timer);
    const ended = active;
    active = null;
    if (ended) {
      lastEndedAt.set(ended.id, now());
      onEnd(ended);
    }
    if (scheduleAfter) {
      scheduleNext();
    }
  };

  const start = (event: WorldEvent) => {
    window.clearTimeout(timer);
    active = event;
    lastId = event.id;
    onStart(event);
    timer = window.setTimeout(() => finish(true), eventDuration(event));
  };

  function scheduleNext() {
    window.clearTimeout(timer);
    if (disposed || events.length === 0) {
      return;
    }

    const next = pickWeighted(eligible(), random);
    if (!next) {
      timer = window.setTimeout(scheduleNext, RETRY_MS);
      return;
    }

    timer = window.setTimeout(() => {
      if (disposed) {
        return;
      }
      if (!canRun(next) || coolingDown(next)) {
        scheduleNext();
        return;
      }
      start(next);
    }, randomBetween(next.minDelay, next.maxDelay, random));
  }

  scheduleNext();

  return {
    trigger(match?: string) {
      if (disposed) {
        return null;
      }
      const pool = (match
        ? events.filter((event) => event.id === match || event.type === match)
        : events
      ).filter(canRun);
      const event = pickWeighted(pool, random);
      if (!event) {
        return null;
      }
      if (active) {
        finish(false);
      }
      start(event);
      return event.id;
    },
    activeId() {
      return active?.id ?? null;
    },
    dispose() {
      disposed = true;
      window.clearTimeout(timer);
      active = null;
    },
  };
}

export type EventScheduler = ReturnType<typeof createEventScheduler>;
