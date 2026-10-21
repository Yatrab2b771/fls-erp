import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { AppLayout } from "./layout/AppLayout";
import { LoadingScreen } from "./components/LoadingScreen";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { IncomingMaterialPage } from "./pages/IncomingMaterialPage";
import { AvailableStockPage } from "./pages/AvailableStockPage";
import { StockReceivedPage } from "./pages/StockReceivedPage";
import { QuarantinePage } from "./pages/QuarantinePage";
import { FinishedGoodsPage } from "./pages/FinishedGoodsPage";
import { StockIssuedPage } from "./pages/StockIssuedPage";
import { MyStoreMovementsPage } from "./pages/MyStoreMovementsPage";
import { MaterialRequestsPage } from "./pages/MaterialRequestsPage";
import { PlanBundlesPage } from "./pages/PlanBundlesPage";
import { NewPlansPage } from "./pages/NewPlansPage";
import { BatchPrepPage } from "./pages/BatchPrepPage";
import { PackagingPage } from "./pages/PackagingPage";
import { PlantStockPage } from "./pages/PlantStockPage";
import { MaterialReceivedPage } from "./pages/MaterialReceivedPage";
import { IndentIssuePage } from "./pages/IndentIssuePage";
import { DayStoreStagePage } from "./pages/DayStoreStagePage";
import { FgStorePage } from "./pages/FgStorePage";
import { ExtraMaterialPage } from "./pages/ExtraMaterialPage";
import { FgDispatchPage, FgWarehouseRequestsPage } from "./pages/FgDispatchPage";
import { HandoverPage } from "./pages/HandoverPage";
import { ProductionReportPage } from "./pages/ProductionReportPage";
import { BatchReportPage } from "./pages/BatchReportPage";
import { NewMaterialPage } from "./pages/NewMaterialPage";
import { ReceivedMaterialPage } from "./pages/ReceivedMaterialPage";
import { ReturnMaterialPage } from "./pages/ReturnMaterialPage";
import { RndMaterialUtilizationPage } from "./pages/RndMaterialUtilizationPage";
import { RndQuarantinePage } from "./pages/RndQuarantinePage";
import { MyStoreRequestsPage } from "./pages/MyStoreRequestsPage";
import { MyStoreProductionRequestsPage } from "./pages/MyStoreProductionRequestsPage";
import { PurchaseOrdersPage } from "./pages/PurchaseOrdersPage";
import { CustomersPage } from "./pages/CustomersPage";
import { VendorsPage } from "./pages/VendorsPage";
import { VendorPurchaseOrdersPage } from "./pages/VendorPurchaseOrdersPage";
import { VendorPurchaseOrderDetailPage } from "./pages/VendorPurchaseOrderDetailPage";
import { StockTransfersPage } from "./pages/StockTransfersPage";
import { PlantConsumptionPage } from "./pages/PlantConsumptionPage";
import { PurchaseOrderDetailPage } from "./pages/PurchaseOrderDetailPage";
import { PpicPlanningDetailPage } from "./pages/PpicPlanningDetailPage";
import { PpicMaterialPlanningPage } from "./pages/PpicMaterialPlanningPage";
import { PpicReadyPosPage } from "./pages/PpicReadyPosPage";
import { BdPlanningDetailPage } from "./pages/BdPlanningDetailPage";
import { PoReviewPage } from "./pages/PoReviewPage";
import { QcStagePage } from "./pages/QcStagePage";
import { RndBomBoardPage } from "./pages/RndBomBoardPage";
import { RndProductionBomPage } from "./pages/RndProductionBomPage";
import { SampleRequestsPage } from "./pages/SampleRequestsPage";
import { VisitingCardsPage } from "./pages/VisitingCardsPage";
import { LeadsPage } from "./pages/LeadsPage";
import { LeadForecastPage } from "./pages/LeadForecastPage";
import { SampleRequestFormPage } from "./pages/SampleRequestFormPage";
import { SampleRequestDetailPage } from "./pages/SampleRequestDetailPage";
import { LeadFormPage } from "./pages/LeadFormPage";
import { LeadDetailPage } from "./pages/LeadDetailPage";
import { LeadFollowUpsPage } from "./pages/LeadFollowUpsPage";
import { BdRequestsPage } from "./pages/BdRequestsPage";
import { HeldProductsPage } from "./pages/HeldProductsPage";
import { PurchasePlanningDetailPage } from "./pages/PurchasePlanningDetailPage";
import { RegulatoryPlanningDetailPage } from "./pages/RegulatoryPlanningDetailPage";
import { StorePlanningDetailPage } from "./pages/StorePlanningDetailPage";
import { MaterialConsumptionReportPage } from "./pages/MaterialConsumptionReportPage";
import { PoFullReportPage } from "./pages/PoFullReportPage";
import { PreProductionDetailPage } from "./pages/PreProductionDetailPage";
import { CombinedLotDetailPage } from "./pages/CombinedLotDetailPage";
import { ProductionBatchDetailPage } from "./pages/ProductionBatchDetailPage";
import { PackagingBomPage } from "./pages/PackagingBomPage";
import { RmCostingPage } from "./pages/RmCostingPage";
import { InventoryPage } from "./pages/InventoryPage";
import { InventoryItemDetailPage } from "./pages/InventoryItemDetailPage";
import { PreInventoryPage } from "./pages/PreInventoryPage";
import { PoReadinessPage } from "./pages/PoReadinessPage";
import { AddOnPlanPage } from "./pages/AddOnPlanPage";
import { InwardQcReportPage } from "./pages/InwardQcReportPage";
import { AccountsDispatchPage } from "./pages/AccountsDispatchPage";
import { VendorPaymentsPage } from "./pages/VendorPaymentsPage";
import { AlertsPage } from "./pages/AlertsPage";
import { DelayedPage } from "./pages/DelayedPage";
import { BulkQcReportPage } from "./pages/BulkQcReportPage";
import { RndSampleRequestsPage } from "./pages/RndSampleRequestsPage";
import { RndReturnsPage } from "./pages/RndReturnsPage";
import { RndDispatchesPage } from "./pages/RndDispatchesPage";
import { UsersPage } from "./pages/UsersPage";
import { RecycleBinPage } from "./pages/RecycleBinPage";
import { SystemHealthPage } from "./pages/SystemHealthPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { RndPage } from "./pages/RndPage";
import { RndStorePage } from "./pages/RndStorePage";
import { RecycleStorePage } from "./pages/RecycleStorePage";
import { RejectedStockPage } from "./pages/RejectedStockPage";
import { ApprovedVendorsPage } from "./pages/ApprovedVendorsPage";
import { CustomerReturnsPage } from "./pages/CustomerReturnsPage";
import { LotsPage } from "./pages/LotsPage";

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
          <Route path="/ppic-planning/material-planning" element={<PpicMaterialPlanningPage />} />
          <Route path="/ppic-planning/po-readiness" element={<PpicReadyPosPage />} />
          <Route path="/ppic-planning/:metric" element={<PpicPlanningDetailPage />} />
          <Route path="/bd-planning/:metric" element={<BdPlanningDetailPage />} />
          <Route path="/po-review/:id" element={<PoReviewPage />} />
          <Route path="/qc/:slug" element={<QcStagePage />} />
          <Route path="/bom-board" element={<RndBomBoardPage />} />
          <Route path="/bom-production" element={<RndProductionBomPage />} />
          <Route path="/sample-requests" element={<SampleRequestsPage />} />
          <Route path="/sample-requests/new" element={<SampleRequestFormPage />} />
          <Route path="/sample-requests/:id" element={<SampleRequestDetailPage />} />
          <Route path="/visiting-cards" element={<VisitingCardsPage />} />
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/leads/new" element={<LeadFormPage />} />
          <Route path="/leads/follow-ups" element={<LeadFollowUpsPage />} />
          <Route path="/leads/forecast" element={<LeadForecastPage />} />
          <Route path="/leads/:id" element={<LeadDetailPage />} />
          <Route path="/bd-requests" element={<BdRequestsPage />} />
          <Route path="/held-products" element={<HeldProductsPage />} />
          <Route path="/purchase-planning/:metric" element={<PurchasePlanningDetailPage />} />
          <Route path="/regulatory-planning/:metric" element={<RegulatoryPlanningDetailPage />} />
          <Route path="/store-planning/quarantine" element={<Navigate to="/quarantine" replace />} />
          <Route path="/store-planning/fg" element={<Navigate to="/finished-goods" replace />} />
          <Route path="/store-planning/:metric" element={<StorePlanningDetailPage />} />
          <Route path="/incoming-material" element={<IncomingMaterialPage />} />
          <Route path="/available-stock" element={<AvailableStockPage />} />
          <Route path="/stock-received" element={<StockReceivedPage />} />
          <Route path="/quarantine" element={<QuarantinePage />} />
          <Route path="/finished-goods" element={<FinishedGoodsPage />} />
          <Route path="/stock-issued" element={<StockIssuedPage />} />
          <Route path="/my-store/received" element={<MyStoreMovementsPage kind="received" />} />
          <Route path="/my-store/requests" element={<MyStoreRequestsPage />} />
          <Route path="/material-requests" element={<MaterialRequestsPage />} />
          <Route path="/material-requests-plan" element={<PlanBundlesPage />} />
          <Route path="/new-plans" element={<NewPlansPage />} />
          <Route path="/batches" element={<NewPlansPage mode="batch" />} />
          <Route path="/batch-indent" element={<BatchPrepPage stage="INDENT_ISSUE" />} />
          <Route path="/batch-no" element={<BatchPrepPage stage="BATCH_NO" />} />
          <Route path="/batch-dispensing" element={<BatchPrepPage stage="DISPENSING" />} />
          {/* Receiving a batch's material now happens on Material Received */}
          <Route path="/batch-receive" element={<Navigate to="/material-received" replace />} />
          <Route path="/packaging" element={<PackagingPage />} />
          <Route path="/plant-stock" element={<PlantStockPage />} />
          <Route path="/material-received" element={<MaterialReceivedPage />} />
          <Route path="/indent-issue" element={<IndentIssuePage />} />
          <Route path="/extra-material" element={<ExtraMaterialPage />} />
          <Route path="/my-store/grn" element={<DayStoreStagePage stage="MATERIAL_RECEIVED" />} />
          <Route path="/my-store/finished-goods" element={<FgStorePage stages={["FG_STORE", "FG_QC_RELEASE", "FG_HANDOVER"]} heading="Finished Goods" blurb="" tileKey="day-store-fg" />} />
          <Route path="/fg-approval" element={<FgStorePage stages={["FG_QC_RELEASE"]} heading="Finished Goods Approval" blurb="Finished goods held at the Day Store, waiting for QA's approval." tileKey="qa-fg" />} />
          <Route path="/finished-goods-dispatch" element={<FgDispatchPage />} />
          <Route path="/fg-warehouse-requests" element={<FgWarehouseRequestsPage />} />
          <Route path="/my-store/dispensing" element={<DayStoreStagePage stage="DISPENSING" />} />
          <Route path="/handover" element={<HandoverPage />} />
          <Route path="/production-report" element={<ProductionReportPage />} />
          <Route path="/production-report/batch/:batchId" element={<BatchReportPage />} />
          <Route path="/new-material" element={<NewMaterialPage />} />
          <Route path="/received-material" element={<ReceivedMaterialPage />} />
          <Route path="/return-material" element={<ReturnMaterialPage />} />
          <Route path="/material-utilization" element={<RndMaterialUtilizationPage />} />
          <Route path="/rnd-quarantine" element={<RndQuarantinePage />} />
          <Route path="/my-store/production-requests" element={<MyStoreProductionRequestsPage />} />
          <Route path="/my-store/issued-to-plant" element={<MyStoreMovementsPage kind="issued-to-plant" />} />
          <Route path="/material-consumption" element={<MaterialConsumptionReportPage />} />
          <Route path="/purchase-orders" element={<PurchaseOrdersPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/vendors" element={<VendorsPage />} />
          <Route path="/vendor-purchase-orders" element={<VendorPurchaseOrdersPage />} />
          <Route path="/vendor-purchase-orders/:id" element={<VendorPurchaseOrderDetailPage />} />
          <Route path="/stock-transfers" element={<StockTransfersPage />} />
          <Route path="/plant-consumption" element={<PlantConsumptionPage />} />
          <Route path="/purchase-orders/:id" element={<PurchaseOrderDetailPage />} />
          <Route path="/purchase-orders/:id/full-report" element={<PoFullReportPage />} />
          <Route path="/pre-productions/:id" element={<PreProductionDetailPage />} />
          <Route path="/production-batches/:id" element={<ProductionBatchDetailPage />} />
          <Route path="/combined-lots/:id" element={<CombinedLotDetailPage />} />
          <Route path="/packaging-bom" element={<PackagingBomPage />} />
          <Route path="/rm-costing" element={<RmCostingPage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/inventory/items/:itemId" element={<InventoryItemDetailPage />} />
          <Route path="/pre-inventory" element={<PreInventoryPage />} />
          <Route path="/po-readiness" element={<PoReadinessPage />} />
          <Route path="/add-on-plan" element={<AddOnPlanPage />} />
          <Route path="/inward-qc" element={<InwardQcReportPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/vendor-payments" element={<VendorPaymentsPage />} />
          <Route path="/accounts-dispatch" element={<AccountsDispatchPage />} />
          <Route path="/delayed" element={<DelayedPage />} />
          <Route path="/bulk-qc" element={<BulkQcReportPage />} />
          <Route path="/rnd-sample-requests" element={<RndSampleRequestsPage />} />
          <Route path="/rnd-returns" element={<RndReturnsPage />} />
          <Route path="/rnd-dispatches" element={<RndDispatchesPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/team" element={<UsersPage />} />
          <Route path="/recycle-bin" element={<RecycleBinPage />} />
          <Route path="/system-health" element={<SystemHealthPage />} />
          <Route path="/audit-log" element={<AuditLogPage />} />
          {/* QC's checkpoint breakdown moved onto "/" itself — old
              bookmarks/links to this path fall through to the catch-all
              below. */}
          <Route path="/qc-dashboard" element={<Navigate to="/" replace />} />
          <Route path="/rnd" element={<RndPage />} />
          <Route path="/rnd-store" element={<RndStorePage />} />
          <Route path="/recycle-store" element={<RecycleStorePage />} />
          <Route path="/stock-adjustments" element={<Navigate to="/" replace />} />
          <Route path="/rejected-stock" element={<RejectedStockPage />} />
          <Route path="/approved-vendors" element={<ApprovedVendorsPage />} />
          {/* A customer return, by department: Warehouse records it, QA decides, Production reworks, Dispatch places it, Accounts makes the credit note */}
          <Route path="/customer-returns" element={<CustomerReturnsPage view="warehouse" />} />
          <Route path="/returned-goods" element={<CustomerReturnsPage view="qa" />} />
          <Route path="/rework" element={<CustomerReturnsPage view="rework" />} />
          <Route path="/returned-goods-dispatch" element={<CustomerReturnsPage view="dispatch" />} />
          <Route path="/credit-notes" element={<CustomerReturnsPage view="accounts" />} />
          <Route path="/lots" element={<LotsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppLayout>
    </BrowserRouter>
  );
}
