"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const IDLE_MS = 4000;

type HudActions = {
  onTogglePlayback: () => void;
  onToggleMute: () => void;
  onPrevWorld: () => void;
  onNextWorld: () => void;
};

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useHudInteraction(actions: HudActions) {
  const [hudVisible, setHudVisible] = useState(true);
  const [idle, setIdle] = useState(false);

  const actionsRef = useRef(actions);
  const idleRef = useRef(false);
  const pointerHeldRef = useRef(false);
  const idleTimerRef = useRef(0);
  const wakeFrameRef = useRef(0);

  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  // While a pointer is held (e.g. dragging a slider) the timer is ignored; pointerup re-arms it.
  const armIdleTimer = useCallback(() => {
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      if (pointerHeldRef.current || idleRef.current) {
        return;
      }
      idleRef.current = true;
      setIdle(true);
    }, IDLE_MS);
  }, []);

  const noteActivity = useCallback(() => {
    if (idleRef.current) {
      idleRef.current = false;
      // Deferred so the wake-up render never lands between pointerdown and click.
      window.cancelAnimationFrame(wakeFrameRef.current);
      wakeFrameRef.current = window.requestAnimationFrame(() => setIdle(false));
    }
    armIdleTimer();
  }, [armIdleTimer]);

  const toggleHud = useCallback(() => {
    setHudVisible((current) => !current);
    idleRef.current = false;
    setIdle(false);
    armIdleTimer();
  }, [armIdleTimer]);

  useEffect(() => {
    const onPointerMove = () => {
      noteActivity();
    };
    const onPointerDown = () => {
      pointerHeldRef.current = true;
      noteActivity();
    };
    const onPointerUp = () => {
      pointerHeldRef.current = false;
      armIdleTimer();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      noteActivity();
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }

      const key = event.key;
      const target = event.target;
      const onButton = target instanceof HTMLElement && target.tagName === "BUTTON";

      if (key === " " && !onButton) {
        event.preventDefault();
        actionsRef.current.onTogglePlayback();
        return;
      }
      if (key === "h" || key === "H") {
        event.preventDefault();
        toggleHud();
        return;
      }
      if (key === "m" || key === "M") {
        event.preventDefault();
        actionsRef.current.onToggleMute();
        return;
      }
      if (key === "ArrowLeft") {
        event.preventDefault();
        actionsRef.current.onPrevWorld();
        return;
      }
      if (key === "ArrowRight") {
        event.preventDefault();
        actionsRef.current.onNextWorld();
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    armIdleTimer();

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(idleTimerRef.current);
      window.cancelAnimationFrame(wakeFrameRef.current);
    };
  }, [armIdleTimer, noteActivity, toggleHud]);

  return {
    hudVisible,
    idle,
    hideCursor: !hudVisible && idle,
    toggleHud,
  };
}
