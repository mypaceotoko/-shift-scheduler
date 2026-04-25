"use client";

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";

export default function SaveToast() {
  const [visible, setVisible] = useState(false);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (useAppStore.persist.hasHydrated()) {
      hydratedRef.current = true;
    }
    const unsubHydration = useAppStore.persist.onFinishHydration(() => {
      hydratedRef.current = true;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useAppStore.subscribe(() => {
      if (!hydratedRef.current) return;
      setVisible(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), 1500);
    });

    return () => {
      unsubHydration();
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div
      aria-live="polite"
      className={`pointer-events-none fixed bottom-4 right-4 z-50 transition-all duration-200 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
      }`}
    >
      <div className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
        ✓ 保存しました
      </div>
    </div>
  );
}
