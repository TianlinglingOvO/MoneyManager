import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import type { Transaction } from "@shared/types";
import { EntryContext } from "./entry-context";
import { api } from "./api";
import { AppShell } from "./components/AppShell";
import { BootSplash } from "./components/BootSplash";
import { QuickEntry } from "./components/QuickEntry";
import { Toast, type ToastMessage } from "./components/Toast";
import { InsightsPage } from "./pages/InsightsPage";
import { useLedgerClock } from "./ledger-clock";
import { ToastContext } from "./toast-context";

const BillsPage = lazy(() => import("./pages/BillsPage").then((module) => ({ default: module.BillsPage })));
const AiPage = lazy(() => import("./pages/AiPage").then((module) => ({ default: module.AiPage })));
const ProposalsPage = lazy(() => import("./pages/ProposalsPage").then((module) => ({ default: module.ProposalsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const MattersPage = lazy(() => import("./pages/MattersPage").then((module) => ({ default: module.MattersPage })));

export default function App() {
  const queryClient = useQueryClient();
  const { isLoading: clockLoading } = useLedgerClock();
  const [searchParams, setSearchParams] = useSearchParams();
  const [entryOpen, setEntryOpen] = useState(false);
  const [editing, setEditing] = useState<Transaction | undefined>();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const entryTrigger = useRef<HTMLElement | null>(null);
  const handledShortcut = useRef(false);
  const openEntry = useCallback((transaction?: Transaction) => {
    entryTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditing(transaction);
    setEntryOpen(true);
  }, []);
  const closeEntry = useCallback(() => {
    setEntryOpen(false);
    setEditing(undefined);
    window.requestAnimationFrame(() => entryTrigger.current?.focus());
  }, []);
  const notify = useCallback((text: string) => setToast({ id: Date.now(), text }), []);

  useEffect(() => {
    let cancelled = false;
    void api.settings().then(async (settings) => {
      const initialized = settings.rows.find((row) => row.key === "timezone.initialized")?.value === "true";
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!cancelled && !initialized && detected) {
        await api.updateTimezone(detected);
        await queryClient.invalidateQueries({ queryKey: ["settings"] });
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [queryClient]);

  useEffect(() => {
    if (clockLoading || handledShortcut.current || searchParams.get("entry") !== "1") return;
    handledShortcut.current = true;
    const next = new URLSearchParams(searchParams);
    next.delete("entry");
    setSearchParams(next, { replace: true });
    openEntry();
  }, [clockLoading, openEntry, searchParams, setSearchParams]);

  return (
    <ToastContext.Provider value={notify}>
    <EntryContext.Provider value={{ openEntry, closeEntry }}>
      <BootSplash />
      <Suspense fallback={<div className="route-loading" aria-label="页面加载中"><span /></div>}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<InsightsPage />} />
            <Route path="bills" element={<BillsPage />} />
            <Route path="analytics" element={<Navigate to="/" replace />} />
            <Route path="ai" element={<AiPage />} />
            <Route path="matters" element={<MattersPage />} />
            <Route path="proposals" element={<ProposalsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
      <QuickEntry
        open={entryOpen}
        transaction={editing}
        onClose={closeEntry}
        onSaved={notify}
      />
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </EntryContext.Provider>
    </ToastContext.Provider>
  );
}
