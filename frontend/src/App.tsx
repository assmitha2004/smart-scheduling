import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './services/auth';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { TaskPanelProvider } from './features/tasks/TaskPanel';
import Landing from './pages/Landing';
import AuthPage from './pages/AuthPage';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
// FullCalendar is heavy; load the calendar page on demand.
const CalendarPage = lazy(() => import('./pages/CalendarPage'));
import ProjectsPage from './pages/ProjectsPage';
import ProjectDetail from './pages/ProjectDetail';
import PlanningPage from './pages/PlanningPage';
import PlanMyTime from './pages/PlanMyTime';
import WeeklyReview from './pages/WeeklyReview';
import { PricingPage, PrivacyPage, TermsPage } from './pages/Public';
import AnalyticsPage from './pages/AnalyticsPage';
import SettingsPage from './pages/SettingsPage';

function RequireAuth({ children, allowUnonboarded }: { children: ReactNode; allowUnonboarded?: boolean }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (!user.onboarded && !allowUnonboarded) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

export default function App() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/" element={user ? <Navigate to="/app" replace /> : <Landing />} />
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/pricing" element={<PricingPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/onboarding" element={<RequireAuth allowUnonboarded><Onboarding /></RequireAuth>} />
      <Route path="/app" element={<RequireAuth><TaskPanelProvider><Layout /></TaskPanelProvider></RequireAuth>}>
        <Route index element={<Dashboard />} />
        <Route path="calendar" element={<Suspense fallback={<Loading />}><CalendarPage /></Suspense>} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<ProjectDetail />} />
        <Route path="plan" element={<PlanMyTime />} />
        <Route path="planning" element={<PlanningPage />} />
        <Route path="review" element={<WeeklyReview />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
