import React from "react";
import { localIsoDate } from "./dateRange";

/** Milliseconds until just after the next local midnight. */
function msUntilNextDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime() + 50;
}

/**
 * Today's local date. Updates at local midnight, and whenever the tab becomes
 * visible or focused again (a sleeping laptop does not fire timers on time).
 */
export function useLocalDay(): string {
  const [day, setDay] = React.useState(() => localIsoDate(new Date()));

  React.useEffect(() => {
    let timer: number | undefined;
    const check = () => setDay(localIsoDate(new Date()));
    const schedule = () => {
      timer = window.setTimeout(() => {
        check();
        schedule();
      }, msUntilNextDay(new Date()));
    };
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") check();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", check);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", check);
    };
  }, []);

  return day;
}
