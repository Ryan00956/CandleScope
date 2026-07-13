import { useCallback, useEffect, useRef, useState } from "react";
import type {
  IntervalNotice,
  IntervalNoticeRuntime,
} from "./chartSessionTypes.js";

export function useIntervalNoticeRuntime(): IntervalNoticeRuntime {
  const [intervalNotice, setIntervalNotice] = useState<IntervalNotice | null>(null);
  const intervalNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (intervalNoticeTimerRef.current) clearTimeout(intervalNoticeTimerRef.current);
  }, []);

  const showIntervalNotice = useCallback((notice: IntervalNotice): void => {
    setIntervalNotice(notice);
    if (intervalNoticeTimerRef.current) clearTimeout(intervalNoticeTimerRef.current);
    intervalNoticeTimerRef.current = setTimeout(() => {
      setIntervalNotice(null);
      intervalNoticeTimerRef.current = null;
    }, notice?.duration || 4200);
  }, []);

  return { intervalNotice, showIntervalNotice };
}
