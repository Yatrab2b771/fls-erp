import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { AppLayout } from "./layout/AppLayout";
import { LoadingScreen } from "./components/LoadingScreen";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { PurchaseOrdersPage } from "./pages/PurchaseOrdersPage";
import { PurchaseOrderDetailPage } from "./pages/PurchaseOrderDetailPage";
import { BatchDetailPage } from "./pages/BatchDetailPage";
import { PackagingBomPage } from "./pages/PackagingBomPage";
import { RmCostingPage } from "./pages/RmCostingPage";
import { InventoryPage } from "./pages/InventoryPage";
import { InventoryItemDetailPage } from "./pages/InventoryItemDetailPage";
import { PreInventoryPage } from "./pages/PreInventoryPage";
import { PoReadinessPage } from "./pages/PoReadinessPage";
import { UsersPage } from "./pages/UsersPage";
import { RecycleBinPage } from "./pages/RecycleBinPage";

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingScreen />;
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
          <Route path="/inventory/items/:itemId" element={<InventoryItemDetailPage />} />
          <Route path="/pre-inventory" element={<PreInventoryPage />} />
          <Route path="/po-readiness" element={<PoReadinessPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/recycle-bin" element={<RecycleBinPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppLayout>
    </BrowserRouter>
  );
}
