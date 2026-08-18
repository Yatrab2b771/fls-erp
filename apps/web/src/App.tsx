import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { AppLayout } from "./layout/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { PurchaseOrdersPage } from "./pages/PurchaseOrdersPage";
import { PurchaseOrderDetailPage } from "./pages/PurchaseOrderDetailPage";
import { BatchDetailPage } from "./pages/BatchDetailPage";
import { PackagingBomPage } from "./pages/PackagingBomPage";
import { RmCostingPage } from "./pages/RmCostingPage";
import { InventoryPage } from "./pages/InventoryPage";
import { UsersPage } from "./pages/UsersPage";

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400 text-sm font-semibold">
        Loading…
      </div>
    );
  }

  if (!user) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      </BrowserRouter>
    );
  }

  return (
    <BrowserRouter>
      <AppLayout>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/purchase-orders" element={<PurchaseOrdersPage />} />
          <Route path="/purchase-orders/:id" element={<PurchaseOrderDetailPage />} />
          <Route path="/batches/:id" element={<BatchDetailPage />} />
          <Route path="/packaging-bom" element={<PackagingBomPage />} />
          <Route path="/rm-costing" element={<RmCostingPage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppLayout>
    </BrowserRouter>
  );
}
