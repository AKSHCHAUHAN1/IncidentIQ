import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { GitBranch, RefreshCw, TrendingUp, AlertTriangle, CheckCircle } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { socket } from '../socket';
import { api } from '../lib/api';

const FEATURES = ['ttfb_ms', 'dns_ms', 'error_rate', 'ssl_days_left'];

const severityConfig = {
  critical: { color: 'text-red-400', border: 'border-red-500/30 bg-red-500/5', icon: <AlertTriangle size={16} className="text-red-400" /> },
  warning:  { color: 'text-amber-400', border: 'border-amber-500/30 bg-amber-500/5', icon: <AlertTriangle size={16} className="text-amber-400" /> },
  normal:   { color: 'text-green-400', border: 'border-green-500/30 bg-green-500/5', icon: <CheckCircle size={16} className="text-green-400" /> },
};

function PredictionCard({ prediction }) {
  const [expanded, setExpanded] = useState(false);
  const conf = prediction.confidence ? (prediction.confidence * 100).toFixed(1) : '—';
  const cfg = severityConfig[prediction.severity] || severityConfig.normal;
  const predData = prediction.prediction_data;

  // Build chart data from LSTM forecast if available
  const chartData = [];
  if (predData?.prediction?.length) {
    predData.prediction.forEach((step, i) => {
      const row = { step: `T+${i + 1}` };
      FEATURES.forEach((f, fi) => {
        row[f] = typeof step[fi] === 'number' ? parseFloat(step[fi].toFixed(1)) : 0;
      });
      chartData.push(row);
    });
  }

  return (
    <motion.div layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      className={`replica-3d-item p-5 cursor-pointer transition-all ${cfg.border}`}
      onClick={() => setExpanded(e => !e)}>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          {cfg.icon}
          <div className="min-w-0">
            <p className="font-semibold text-white text-sm truncate">{prediction.url || prediction.service_id}</p>
            <p className="text-xs text-gray-500 font-mono">
              {new Date(prediction.created_at).toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-3">
          <span className={`px-2 py-0.5 rounded text-xs border font-mono font-bold ${cfg.color} ${cfg.border}`}>
            {prediction.severity?.toUpperCase()}
          </span>
          <span className="text-xs font-mono text-gray-400">{conf}%</span>
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="mt-4 pt-4 border-t border-white/5 overflow-hidden">

            {/* Forecast chart */}
            {chartData.length > 0 ? (
              <div className="mb-4">
                <p className="text-xs text-gray-500 font-mono mb-2">LSTM Forecast (next {chartData.length} steps)</p>
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={chartData}>
                    <XAxis dataKey="step" stroke="#64748b" tick={{ fill: '#64748b', fontSize: 10 }} />
                    <YAxis stroke="#64748b" tick={{ fill: '#64748b', fontSize: 10 }} />
                    <Tooltip contentStyle={{ backgroundColor: 'rgba(15,17,23,0.95)', borderColor: 'rgba(255,255,255,0.1)', fontSize: 10 }} />
                    <ReferenceLine y={2000} stroke="#ef4444" strokeDasharray="3 3" label="" />
                    <Line type="monotone" dataKey="ttfb_ms" stroke="#6366f1" strokeWidth={1.5} dot={false} name="TTFB ms" />
                    <Line type="monotone" dataKey="dns_ms" stroke="#06b6d4" strokeWidth={1.5} dot={false} name="DNS ms" />
                    <Line type="monotone" dataKey="error_rate" stroke="#f59e0b" strokeWidth={1} dot={false} name="Error Rate %" strokeDasharray="4 2" />
                    <Line type="monotone" dataKey="ssl_days_left" stroke="#22c55e" strokeWidth={1} dot={false} name="SSL days" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-xs text-gray-600 font-mono mb-4">No forecast data available</p>
            )}

            {/* Prediction details */}
            <div className="grid grid-cols-2 gap-3 font-mono text-xs">
              <div className="replica-3d-item p-3">
                <span className="text-gray-500">Model</span>
                <p className="text-white font-bold">{prediction.model_name || 'ensemble'}</p>
              </div>
              <div className="replica-3d-item p-3">
                <span className="text-gray-500">Status</span>
                <p className={`font-bold ${prediction.status === 'action_taken' ? 'text-green-400' : prediction.status === 'ignored' ? 'text-gray-400' : 'text-amber-400'}`}>
                  {(prediction.status || 'open').replace(/_/g, ' ')}
                </p>
              </div>
                <div className="replica-3d-item p-3 col-span-2">
                  <span className="text-gray-500">Root Cause</span>
                  <p className="text-white font-bold">{(prediction.prediction_data?.root_cause || 'normal').replace(/_/g, ' ')}</p>
                  {prediction.prediction_data?.breach_eta_min && (
                    <p className="text-amber-400 text-[11px] mt-1">SLA breach ETA: {prediction.prediction_data.breach_eta_min} min</p>
                  )}
                </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function Predictions() {
  const [predictions, setPredictions] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [filter, setFilter]           = useState('all');

  async function fetchPredictions() {
    try {
      const params = { limit: 100 };
      if (filter !== 'all') params.severity = filter;
      const d = await api.predictions(params);
      setPredictions(d.predictions || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    fetchPredictions();

    const handler = () => fetchPredictions();
    socket.on('new_prediction', handler);
    return () => socket.off('new_prediction', handler);
  }, [filter]);

  const counts = {
    all:      predictions.length,
    critical: predictions.filter(p => p.severity === 'critical').length,
    warning:  predictions.filter(p => p.severity === 'warning').length,
    normal:   predictions.filter(p => p.severity === 'normal').length,
  };

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="relative z-10 pt-32 px-10 max-w-5xl mx-auto pb-20">

      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <GitBranch className="text-indigo-400 w-7 h-7" />
          <h1 className="text-3xl font-bold tracking-tighter">Predictions</h1>
        </div>
        <button onClick={fetchPredictions} className="text-gray-500 hover:text-white transition-colors">
          <RefreshCw size={16} />
        </button>
      </div>
      <p className="text-gray-400 mb-8 tracking-tighter">
        LSTM trajectory forecasts and SLA breach risk across monitored URLs.
      </p>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-8">
        {['all', 'critical', 'warning', 'normal'].map(f => (
          <button key={f} onClick={() => { setFilter(f); setLoading(true); }}
            className={`px-4 py-2 rounded-full text-xs font-mono font-bold transition-all border ${
              filter === f
                ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
                : 'bg-white/5 text-gray-400 border-white/10 hover:border-white/20'
            }`}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
            <span className="ml-2 opacity-60">{counts[f] || 0}</span>
          </button>
        ))}
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          { label: 'Critical', value: counts.critical, color: 'text-red-400', icon: <AlertTriangle size={14} /> },
          { label: 'Warning',  value: counts.warning,  color: 'text-amber-400', icon: <AlertTriangle size={14} /> },
          { label: 'Normal',   value: counts.normal,   color: 'text-green-400', icon: <TrendingUp size={14} /> },
        ].map((s, i) => (
          <div key={i} className="replica-3d-item p-4 flex items-center gap-3">
            <span className={s.color}>{s.icon}</span>
            <div>
              <p className={`text-2xl font-bold tracking-tighter ${s.color}`}>{s.value}</p>
              <p className="text-xs text-gray-500">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Predictions list */}
      {loading ? (
        <p className="text-gray-500 font-mono animate-pulse">Loading predictions...</p>
      ) : predictions.length === 0 ? (
        <div className="tech-border bg-black/40 rounded-2xl p-16 flex flex-col items-center gap-4 text-center">
          <TrendingUp size={32} className="text-gray-600" />
          <p className="text-gray-400 font-mono">No predictions yet.</p>
          <p className="text-gray-600 text-sm">Predictions appear after the ML pipeline processes enough probe data.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <AnimatePresence>
            {predictions.map(pred => (
              <PredictionCard key={pred.id} prediction={pred} />
            ))}
          </AnimatePresence>
        </div>
      )}
    </motion.main>
  );
}