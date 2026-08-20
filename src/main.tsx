import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AppearanceProvider } from "./appearance";
import { LedgerClockProvider } from "./ledger-clock";
import { shouldRetryRequest } from "./api";
import "./generated-fonts.css";
import "./styles.css";
import { startAppUpdates } from "./pwa-update";

startAppUpdates();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
      refetchOnReconnect: "always",
      refetchOnWindowFocus: "always",
      retry: shouldRetryRequest
    },
    mutations: { retry: 0 }
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LedgerClockProvider>
        <AppearanceProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AppearanceProvider>
      </LedgerClockProvider>
    </QueryClientProvider>
  </StrictMode>
);
