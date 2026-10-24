import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth, useAuth } from "./auth/AuthProvider";
import { LoginPage } from "./auth/LoginPage";
import { AppShell } from "./components/AppShell";
import { LibraryPage } from "./pages/LibraryPage";
import { UploadPage } from "./pages/UploadPage";
import { BookDetailPage } from "./pages/BookDetailPage";
import { EditBookPage } from "./pages/EditBookPage";
import { AdminPage } from "./pages/AdminPage";

function AdminRoute() {
  const { user } = useAuth();
  return user?.role === "admin" ? <AdminPage /> : <Navigate to="/" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/books/:id" element={<BookDetailPage />} />
          <Route path="/books/:id/edit" element={<EditBookPage />} />
          <Route path="/admin" element={<AdminRoute />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
