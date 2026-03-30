import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts';
import { BarChart2, TrendingUp, Zap, Clock, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

const pageVariants = {
  initial: { opacity: 0, y: 20 },
  in:      { opacity: 1, y: 0, transition: { duration: 0.5 } },
  out:     { opacity: 0,       transition: { duration: 0.3 } },
};

const StatCard = ({ icon, label, value, sub, color = 'text-white' }) => (
  <div className="replica-3d-item p-6 flex flex-col gap-2">
    <div className="flex items-center gap-2 text-gray-500 text-xs font-mono uppercase tracking-wider">
      {icon}
      {label}
    </div>
    <div className={`text-3xl font-bold tracking-tighter ${color}`}>{value}</div>
    {sub && <div className="text-xs text-gray-500">{sub}</div>}
  </div>
);

const MODEL_ROWS = [
  { name: 'LSTM Predictor',   type: 'TTFB Forecasting',  key: 'lstm_loaded',  note: 'Z-score normalized SLA trajectory model' },
  { name: 'Isolation Forest', type: 'Anomaly Detection', key: 'iso_loaded',   note: '300 trees, 5% contamination' },
  { name: 'Pattern Classifier', type: 'Root Cause',      key: 'log_loaded',   note: 'TF-IDF + Logistic Regression on metric tokens' },
  { name: 'Ensemble Fusion',  type: 'Multi-model Fusion',key: 'ensemble',     note: 'LSTM + Isolation Forest + Pattern classifier' },
];

export default function Analytics() {
  const [summary,  setSummary]  = useState(null);
  const [accuracy, setAccuracy] = useState([]);
  const [services, setServices] = useState([]);
  const [mlHealth, setMlHealth] = useState(null);
  const [loading,  setLoading]  = useState(true);

  async function fetchAll() {
    setLoading(true);
    try {
      const [s, a, svc] = await Promise.all([
        api.summary(),
        api.accuracyTrend(),
        api.serviceStats(),
      ]);
      setSummary(s);
      setAccuracy(a.accuracy_trend || []);
      setServices(svc.services     || []);

      // ML health — proxied through api-gateway (no CORS issues)
      try {
        const h = await api.mlHealth();
        setMlHealth(h);
      } catch {
        setMlHealth(null);
      }
    } catch (err) {
      console.error('Analytics fetch failed:', err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchAll();
  }, []);

  const topStats = summary ? [
    {
      icon:  <TrendingUp size={14} />,
      label: 'Avg Prediction Confidence',
      value: `${summary.predictions?.confidence_avg_pct ?? 0}%`,
      sub:   `${summary.predictions?.total ?? 0} total predictions`,
      color: (summary.predictions?.confidence_avg_pct ?? 0) > 70 ? 'text-green-400' : 'text-amber-400',
    },
    {
      icon:  <Zap size={14} />,
      label: 'Reports Dispatched',
      value: String(summary.remediations?.alert_reports ?? 0),
      sub:   'structured alert dispatches',
      color: 'text-indigo-400',
    },
    {
      icon:  <BarChart2 size={14} />,
      label: 'SLA Compliance (24h)',
      value: `${summary.sla?.compliance_pct ?? 0}%`,
      sub:   `${summary.sla?.last_24h_breaches ?? 0} breaches over ${summary.sla?.last_24h_total ?? 0} probes`,
      color: (summary.sla?.compliance_pct ?? 0) > 95 ? 'text-green-400' : 'text-amber-400',
    },
    {
      icon:  <Clock size={14} />,
      label: 'Avg MTTR',
      value: summary.mttr_minutes ? `${summary.mttr_minutes}m` : '—',
      sub:   'mean time to resolve',
      color: 'text-white',
    },
  ] : [];

  const accuracyChart = accuracy.map(r => ({
    date:     new Date(r.date).toLocaleDateString('en', { month: 'short', day: 'numeric' }),
    accuracy: r.accuracy,
  }));

  const servicesChart = services.map(s => ({
    service:   s.service_id,
    incidents: parseInt(s.total_incidents  || 0),
    critical:  parseInt(s.critical         || 0),
    prevented: parseInt(s.prevented        || 0),
  }));

  return (
    <motion.main initial="initial" animate="in" exit="out" variants={pageVariants}
      className="relative z-10 pt-32 px-10 max-w-7xl mx-auto pb-20">

      <div className="flex items-center justify-between mb-2">
        <h1 className="text-3xl font-bold tracking-tighter">Analytics</h1>
        <button onClick={fetchAll} className="text-gray-500 hover:text-white transition-colors">
          <RefreshCw size={16} />
        </button>
      </div>
      <p className="text-gray-400 mb-10 tracking-tighter">
        Model performance, prediction accuracy, and system health.
      </p>

      {loading ? (
        <div className="text-gray-500 font-mono animate-pulse">Loading analytics...</div>
      ) : (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
            {topStats.map((s, i) => <StatCard key={i} {...s} />)}
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">

            {/* Accuracy trend */}
            <div className="tech-border bg-black/40 backdrop-blur-xl rounded-2xl p-6">
              <h3 className="text-sm font-mono text-gray-400 uppercase tracking-wider mb-6">
                Prediction Accuracy — 30 Days
              </h3>
              {accuracyChart.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={accuracyChart}>
                    <defs>
                      <linearGradient id="accGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#6366f1" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0}   />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis dataKey="date"    stroke="#64748b" tick={{ fill: '#64748b', fontSize: 10 }} />
                    <YAxis domain={[0, 100]} stroke="#64748b" tick={{ fill: '#64748b', fontSize: 10 }}
                           tickFormatter={v => `${v}%`} />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'rgba(15,17,23,0.95)', borderColor: 'rgba(255,255,255,0.1)', fontSize: 11 }}
                      formatter={v => [`${v}%`, 'Accuracy']}
                    />
                    <Area type="monotone" dataKey="accuracy" stroke="#6366f1" strokeWidth={2}
                          fill="url(#accGrad)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-56 flex items-center justify-center text-gray-600 font-mono text-sm">
                  No accuracy data yet — predictions accumulate over time
                </div>
              )}
            </div>

            {/* Incidents by service */}
            <div className="tech-border bg-black/40 backdrop-blur-xl rounded-2xl p-6">
              <h3 className="text-sm font-mono text-gray-400 uppercase tracking-wider mb-6">
                Incidents by Service
              </h3>
              {servicesChart.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={servicesChart} barSize={24}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis dataKey="service" stroke="#64748b" tick={{ fill: '#64748b', fontSize: 10 }} />
                    <YAxis stroke="#64748b" tick={{ fill: '#64748b', fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'rgba(15,17,23,0.95)', borderColor: 'rgba(255,255,255,0.1)', fontSize: 11 }}
                    />
                    <Bar dataKey="incidents" name="Total"     fill="#6366f1" radius={[4,4,0,0]} />
                    <Bar dataKey="critical"  name="Critical"  fill="#ef4444" radius={[4,4,0,0]} />
                    <Bar dataKey="prevented" name="Prevented" fill="#22c55e" radius={[4,4,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-56 flex items-center justify-center text-gray-600 font-mono text-sm">
                  No incident data yet
                </div>
              )}
            </div>
          </div>

          {/* Model registry */}
          <div className="tech-border bg-black/40 backdrop-blur-xl rounded-2xl overflow-hidden">
            <div className="p-6 border-b border-white/5">
              <h3 className="text-sm font-mono text-gray-400 uppercase tracking-wider">
                Model Registry
              </h3>
            </div>
            <table className="w-full text-left text-sm">
              <thead className="bg-[#0f1117] text-gray-400 font-mono text-xs uppercase tracking-wider">
                <tr>
                  <th className="p-4">Model</th>
                  <th className="p-4">Type</th>
                  <th className="p-4">Runtime Status</th>
                  <th className="p-4">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {MODEL_ROWS.map((m, i) => {
                  let loaded = true;
                  if (mlHealth) {
                    if (m.key === 'ensemble') loaded = mlHealth.lstm_loaded && mlHealth.iso_loaded;
                    else loaded = mlHealth[m.key] ?? false;
                  }
                  return (
                    <tr key={i} className="hover:bg-white/5 transition-colors">
                      <td className="p-4 font-mono text-white text-xs">{m.name}</td>
                      <td className="p-4 text-gray-400 text-xs">{m.type}</td>
                      <td className="p-4">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-mono px-2 py-1 rounded-full border ${
                          loaded
                            ? 'bg-green-500/10 text-green-400 border-green-500/20'
                            : 'bg-red-500/10 text-red-400 border-red-500/20'
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${loaded ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
                          {loaded ? 'Active' : 'Not Loaded'}
                        </span>
                      </td>
                      <td className="p-4 text-gray-500 text-xs font-mono">{m.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </motion.main>
  );
}