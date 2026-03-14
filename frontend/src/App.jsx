import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { Suspense, lazy } from 'react';
import Navbar from './components/Navbar';
import ParticleGlobe from './components/ParticleGlobe';

const Dashboard   = lazy(() => import('./pages/Dashboard'));
const Monitor     = lazy(() => import('./pages/Monitor'));
const Predictions = lazy(() => import('./pages/Predictions'));
const Incidents   = lazy(() => import('./pages/Incidents'));
const Approvals   = lazy(() => import('./pages/Approvals'));
const Analytics   = lazy(() => import('./pages/Analytics'));

function AnimatedRoutes() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <Suspense fallback={<div className="pt-32 px-10 text-gray-400 font-mono animate-pulse">Loading...</div>}>
        <Routes location={location} key={location.pathname}>
          <Route path="/"            element={<Dashboard />}   />
          <Route path="/monitor"     element={<Monitor />}     />
          <Route path="/predictions" element={<Predictions />} />
          <Route path="/incidents"   element={<Incidents />}   />
          <Route path="/alerts"      element={<Approvals />}   />
          <Route path="/approvals"   element={<Navigate to="/alerts" replace />} />
          <Route path="/analytics"   element={<Analytics />}   />
        </Routes>
      </Suspense>
    </AnimatePresence>
  );
}

export default function App() {
  return (
    <Router>
      <div className="min-h-screen bg-background text-white selection:bg-indigo/30 overflow-x-hidden font-sans">
        <ParticleGlobe />
        <Navbar />
        <AnimatedRoutes />
      </div>
    </Router>
  );
}