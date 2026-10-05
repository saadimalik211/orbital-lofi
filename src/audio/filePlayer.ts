export type FilePlayerHandlers = {
  onPlaying: () => void;
  onEnded: () => void;
  onError: (error: unknown) => void;
};

export type FilePlayer = {
  play: (src: string, handlers: FilePlayerHandlers) => void;
  stop: () => void;
  dispose: () => void;
};

/**
 * Streams music files through one reused <audio> element routed into the Web Audio graph,
 * so long tracks are not decoded into memory and two files can never play at once.
 */
export function createFilePlayer(context: AudioContext, destination: AudioNode): FilePlayer {
  const element = new Audio();
  element.preload = "auto";
  const source = context.createMediaElementSource(element);
  source.connect(destination);
  let generation = 0;

  const stop = () => {
    generation += 1;
    element.onplaying = null;
    element.onended = null;
    element.onerror = null;
    element.pause();
    element.removeAttribute("src");
    element.load();
  };

  return {
    play(src, handlers) {
      stop();
      const current = generation;
      let failed = false;
      const fail = (error: unknown) => {
        if (current === generation && !failed) {
          failed = true;
          handlers.onError(error);
        }
      };
      element.onplaying = () => {
        if (current === generation) {
          handlers.onPlaying();
        }
      };
      element.onended = () => {
        if (current === generation) {
          handlers.onEnded();
        }
      };
      element.onerror = () => fail(element.error);
      element.src = src;
      element.play().catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          fail(error);
        }
      });
    },
    stop,
    dispose() {
      stop();
      source.disconnect();
    },
  };
}
