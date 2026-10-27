import { copy } from "./lib/copy";
import React, { lazy, Suspense } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { ThemeProvider } from "./ui/foundation/ThemeProvider.jsx";
import { ToastProvider } from "./ui/components/Toast.jsx";
import { AppLayout } from "./ui/components/Sidebar.jsx";
import { ForkScope } from "./components/ForkScope.jsx";
const DashboardPage = lazy(() =>
  import("./pages/DashboardPage.jsx").then((m) => ({
    default: m.DashboardPage,
  })),
);
const SessionsPage = lazy(() =>
  import("./pages/SessionsPage.jsx").then((m) => ({ default: m.SessionsPage })),
);
const LimitsPage = lazy(() =>
  import("./pages/LimitsPage.jsx").then((m) => ({ default: m.LimitsPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage.jsx").then((m) => ({ default: m.SettingsPage })),
);
const WrappedPage = lazy(() => import("./pages/WrappedPage.jsx"));
const SyncPage = lazy(() => import("./pages/ForkSyncPage.jsx"));
export default function App() {
  const path = useLocation().pathname.replace(/\/+$/, "") || "/";
  const pages = {
    "/": DashboardPage,
    "/dashboard": DashboardPage,
    "/sessions": SessionsPage,
    "/limits": LimitsPage,
    "/settings": SettingsPage,
    "/devices": SyncPage,
    "/wrapped": WrappedPage,
  };
  const Page = pages[path];
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ToastProvider>
          <AppLayout>
            <ForkScope />
            <Suspense
              fallback={
                <p className="p-6">{copy("fork.personal.300ee3dee4")}</p>
              }
            >
              {Page ? (
                <Page baseUrl="" signedIn auth={null} publicMode={false} />
              ) : (
                <Navigate to="/dashboard" replace />
              )}
            </Suspense>
          </AppLayout>
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
