import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/newsreader";
import "./styles/index.css";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthProvider";

const queryClient = new QueryClient();

// The service worker only exists in the built bundle; registering the dev
// server's stale copy would cache half-built assets.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline support is progressive; a failed register must not break the app.
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
