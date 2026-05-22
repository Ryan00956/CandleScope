import { useCallback, useEffect, useRef, useState } from "react";

export function useIntervalNoticeRuntime() {
  const [intervalNotice, setIntervalNotice] = useState(null);
  const intervalNoticeTimerRef = useRef(null);

  useEffect(() => () => {
    if (intervalNoticeTimerRef.current) clearTimeout(intervalNoticeTimerRef.current);
  }, []);

  const showIntervalNotice = useCallback((notice) => {
    setIntervalNotice(notice);
    if (intervalNoticeTimerRef.current) clearTimeout(intervalNoticeTimerRef.current);
    intervalNoticeTimerRef.current = setTimeout(() => {
      setIntervalNotice(null);
      intervalNoticeTimerRef.current = null;
    }, notice?.duration || 4200);
  }, []);

  return { intervalNotice, showIntervalNotice };
}
