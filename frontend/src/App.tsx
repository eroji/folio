import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { RequireAuth, useAuth } from "./auth/AuthProvider";
import { LoginPage } from "./auth/LoginPage";
import { AppShell } from "./components/AppShell";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { SearchPage } from "./pages/SearchPage";
import { UploadPage } from "./pages/UploadPage";
import { BookDetailPage } from "./pages/BookDetailPage";
import { EditBookPage } from "./pages/EditBookPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AdminPage } from "./pages/AdminPage";
import { PlayerPage } from "./components/PlayerPage";

function AdminRoute() {
  const { user } = useAuth();
  return user?.role === "admin" ? <AdminPage /> : <Navigate to="/" replace />;
}

/** Search moved to /search; old ?q= links on the library redirect. */
function LibraryRoute() {
  const [params] = useSearchParams();
  const q = params.get("q");
  if (q) return <Navigate to={`/search?q=${encodeURIComponent(q)}`} replace />;
  return <LibraryPage />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/library" element={<LibraryRoute />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/books/:id" element={<BookDetailPage />} />
          <Route path="/books/:id/edit" element={<EditBookPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/player" element={<PlayerPage />} />
          <Route path="/admin" element={<AdminRoute />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
