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
export default function App() {
  const location = useLocation();
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const pages = {
    "/": DashboardPage,
    "/dashboard": DashboardPage,
    "/sessions": SessionsPage,
    "/limits": LimitsPage,
    "/settings": SettingsPage,
    "/wrapped": WrappedPage,
  };
  const Page = pages[path];
  // The old /devices page moved into Settings; send legacy links to its section.
  let content;
  if (path === "/devices") {
    const settingsQuery = new URLSearchParams(location.search);
    settingsQuery.set("section", "sync");
    content = <Navigate to={`/settings?${settingsQuery.toString()}`} replace />;
  } else if (Page) {
    content = <Page baseUrl="" signedIn auth={null} publicMode={false} />;
  } else {
    content = <Navigate to="/dashboard" replace />;
  }
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
              {content}
            </Suspense>
          </AppLayout>
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
