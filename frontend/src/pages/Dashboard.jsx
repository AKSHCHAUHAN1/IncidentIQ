import { useState, useEffect, useRef } from 'react';
import { motion, useMotionValue, useTransform } from 'framer-motion';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { socket } from '../socket';
import { api } from '../lib/api';

const useTypewriter = (texts) => {
  const [textIndex, setTextIndex] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTextIndex(p => (p + 1) % texts.length), 3000);
    return () => clearInterval(interval);
  }, [texts]);
  return texts[textIndex];
};

const TiltCard = ({ children, className = "" }) => {
  const x = useMotionValue(200);
  const y = useMotionValue(200);
  const rotateX = useTransform(y, [0, 400], [5, -5]);
  const rotateY = useTransform(x, [0, 400], [-5, 5]);
  const handleMouse = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    x.set(event.clientX - rect.left);
    y.set(event.clientY - rect.top);
  };
  return (
    <motion.div
      onMouseMove={handleMouse}
      onMouseLeave={() => { x.set(200); y.set(200); }}
      style={{ rotateX, rotateY, transformPerspective: 1000 }}
      className={`replica-3d-card transition-all duration-300 hover:border-indigo/40 group ${className}`}
    >
      <motion.div
        className="absolute inset-0 z-0 pointer-events-none opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: useTransform(
            [x, y],
            ([lx, ly]) => `radial-gradient(400px circle at ${lx}px ${ly}px, rgba(99,102,241,0.15), transparent 40%)`
          )
        }}
      />
      <div className="relative z-10 p-6 h-full flex flex-col">{children}</div>
    </motion.div>
  );
};

export default function Dashboard() {
  const headingText = useTypewriter(["Predict Failures", "Auto-Remediate", "Prevent Downtime"]);

  // ── State ──────────────────────────────────────────────────
  const [stats, setStats] = useState([
    { label: "Total Incidents",    value: "—",  sub: "loading...",     alert: false },
    { label: "Active Alerts",      value: "—",  sub: "loading...",     alert: false },
    { label: "Predictions (24h)",  value: "—",  sub: "loading..." },
    { label: "Auto-Resolved",      value: "—",  sub: "loading..." },
  ]);
  const [metricsData, setMetricsData]         = useState([]);
  const [activePredictions, setActivePredictions] = useState([]);
  const timer = useRef(null);

  // ── Fetch helpers ─────────────────────────────────────────
  async function fetchSummary() {
    try {
      const d = await api.summary();
      setStats([
        { label: "Total Incidents",   value: String(d.incidents.total),           sub: `${d.incidents.critical} critical`,            alert: false },
        { label: "Active Alerts",     value: String(d.remediations.pending),       sub: "pending approval",                            alert: d.remediations.pending > 0 },
        { label: "Predictions (24h)", value: String(d.predictions.last_24h),       sub: `${d.predictions.accuracy_pct}% accuracy` },
        { label: "Auto-Resolved",     value: String(d.remediations.auto_executed), sub: "auto-executed" },
      ]);
    } catch {}
  }

  async function fetchMetrics() {
    try {
      const d = await api.metricsLive('service-a', 30);
      if (d.metrics?.length) {
        setMetricsData(d.metrics.map(m => ({
          time:        new Date(m.time).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          cpu:         parseFloat((m.cpu    || 0).toFixed(1)),
          memory:      parseFloat((m.memory || 0).toFixed(1)),
          error_rate:  parseFloat((m.error_rate || 0).toFixed(2)),
        })));
      }
    } catch {}
  }

  async function fetchPredictions() {
    try {
      const d = await api.predictions({ limit: 5 });
      if (d.predictions?.length) {
        setActivePredictions(d.predictions.map(p => ({
          service:  p.service_id,
          conf:     (p.confidence * 100).toFixed(0),
          issue:    `${p.severity.toUpperCase()} — ${(p.confidence * 100).toFixed(0)}% confidence`,
          severity: p.severity,
        })));
      }
    } catch {}
  }

  useEffect(() => {
    fetchSummary(); fetchMetrics(); fetchPredictions();
    timer.current = setInterval(() => { fetchSummary(); fetchMetrics(); fetchPredictions(); }, 10_000);

    // Live socket events
    socket.on('prediction', (pred) => {
      setActivePredictions(prev => [{
        service:  pred.service_id,
        conf:     (pred.confidence * 100).toFixed(0),
        issue:    `${pred.severity?.toUpperCase()} — ${(pred.confidence * 100).toFixed(0)}% confidence`,
        severity: pred.severity,
      }, ...prev].slice(0, 5));
      fetchSummary();
    });

    return () => { clearInterval(timer.current); socket.off('prediction'); };
  }, []);

  const containerVars = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.1, delayChildren: 0.2 } }
  };

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="relative z-10 pt-40 px-10 max-w-7xl mx-auto flex flex-col items-center">

      {/* Hero — untouched from your design */}
      <div className="replica-3d-card text-center mb-16 p-10 relative w-full max-w-4xl">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[300px] bg-indigo/20 blur-[100px] rounded-full pointer-events-none z-0" />
        <div className="relative z-10 inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-green-500/10 border border-green-500/30 text-green-400 text-xs font-mono mb-8 backdrop-blur-sm shadow-[0_0_15px_rgba(34,197,94,0.2)]">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_8px_#22c55e]" />
          System Online & Monitoring
        </div>
        {/* Bulletproof Typewriter Heading */}
        <h1 className="relative z-10 text-white mb-8 font-extrabold tracking-tighter drop-shadow-[0_0_15px_rgba(255,255,255,0.4)]">
          <motion.span 
            key={headingText} 
            initial={{ opacity: 0, y: 10 }} 
            animate={{ opacity: 1, y: 0 }} 
            transition={{ duration: 0.4 }}
            className="inline-block"
          >
            {headingText}
          </motion.span>
        </h1>
        <p className="relative z-10 text-gray-400 max-w-2xl mx-auto text-lg tracking-tighter mb-8">
          LSTM forecasting integrated with pgvector similarity search.<br/>
          Securing infrastructure 30 minutes before failure.
        </p>
        <div className="relative z-10 mt-4 grid grid-cols-1 md:grid-cols-3 gap-6 border-t border-white/10 pt-8 text-left max-w-3xl mx-auto">
          <div className="replica-3d-item space-y-1 p-4">
            <p className="text-xs text-gray-500 font-mono uppercase">ML Model Status</p>
            <p className="text-sm text-indigo font-mono flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo animate-pulse"/> LSTM Active (v2.4)
            </p>
          </div>
          <div className="replica-3d-item space-y-1 p-4">
            <p className="text-xs text-gray-500 font-mono uppercase">Vector Database</p>
            <p className="text-sm text-gray-300 font-mono">pgvector connected</p>
          </div>
          <div className="replica-3d-item space-y-1 p-4">
            <p className="text-xs text-gray-500 font-mono uppercase">Prediction Window</p>
            <p className="text-sm text-gray-300 font-mono">T-30 Minutes</p>
          </div>
        </div>
      </div>

      {/* Beam divider */}
      <div className="w-full h-[1px] bg-white/5 relative overflow-hidden mb-16">
        <motion.div animate={{ x: ["-100%", "300%"] }} transition={{ repeat: Infinity, duration: 3, ease: "linear" }}
          className="absolute top-0 left-0 w-1/3 h-full bg-gradient-to-r from-transparent via-indigo to-transparent" />
      </div>

      {/* Stat Cards — now with real data */}
      <motion.div variants={containerVars} initial="hidden" animate="show" className="grid grid-cols-1 md:grid-cols-4 gap-6 w-full mb-12">
        {stats.map((stat, i) => (
          <TiltCard key={i} className="h-40">
            <span className="text-sm text-gray-400 group-hover:text-white transition-colors relative z-10">{stat.label}</span>
            <div className="mt-auto relative z-10">
              <span className={`text-4xl font-bold tracking-tighter drop-shadow-md ${stat.alert ? 'text-critical' : 'text-white'}`}>{stat.value}</span>
              <p className="text-xs text-gray-500 mt-1">{stat.sub}</p>
            </div>
          </TiltCard>
        ))}
      </motion.div>

      {/* Two-column */}
      <motion.div variants={containerVars} initial="hidden" animate="show" className="grid grid-cols-1 lg:grid-cols-3 gap-6 w-full pb-20">

        {/* Live chart — real data */}
        <TiltCard className="col-span-2 h-96">
          <h3 className="text-xl font-semibold mb-4 text-white/90 relative z-10 drop-shadow-sm">Live Metrics & LSTM Forecast</h3>
          {metricsData.length > 0 ? (
            <div className="w-full h-64 relative z-10">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={metricsData}>
                  <XAxis dataKey="time" stroke="#64748b" tick={{ fill: '#64748b', fontSize: 10 }} interval="preserveStartEnd" />
                  <YAxis stroke="#64748b" tick={{ fill: '#64748b', fontSize: 10 }} />
                  <Tooltip contentStyle={{ backgroundColor: 'rgba(15,17,23,0.95)', borderColor: 'rgba(255,255,255,0.1)', backdropFilter: 'blur(10px)', fontSize: 11 }} />
                  <ReferenceLine y={80} stroke="#ef4444" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="cpu"        name="CPU %"      stroke="#6366f1" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="memory"     name="Memory %"   stroke="#ef4444" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="error_rate" name="Error Rate" stroke="#f59e0b" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="w-full h-64 flex items-center justify-center text-gray-600 relative rounded-xl border border-white/5 bg-black/40 z-10">
              <span className="text-sm font-mono tracking-widest text-white/30">[ LOADING METRICS... ]</span>
            </div>
          )}
        </TiltCard>

        {/* Active predictions — real data */}
        <TiltCard className="col-span-1 h-96 overflow-y-auto">
          <h3 className="text-xl font-semibold mb-4 text-white/90 relative z-10 drop-shadow-sm">Active Predictions</h3>
          <div className="space-y-4 relative z-10">
            {activePredictions.length === 0 ? (
              <p className="text-gray-600 text-sm font-mono">No predictions yet — system normal</p>
            ) : activePredictions.map((pred, i) => (
              <div key={i} className="replica-3d-item p-4 hover:border-critical/50 hover:bg-critical/10 transition-colors cursor-pointer group">
                <div className="flex justify-between items-start mb-2">
                  <span className={`font-bold text-sm group-hover:drop-shadow-[0_0_8px_rgba(239,68,68,0.8)] transition-all ${pred.severity === 'critical' ? 'text-critical' : 'text-amber-400'}`}>
                    {pred.service}
                  </span>
                  <span className="text-xs font-mono text-white/50">{pred.conf}% Conf.</span>
                </div>
                <p className="text-sm text-gray-300">{pred.issue}</p>
              </div>
            ))}
          </div>
        </TiltCard>
      </motion.div>
    </motion.main>
  );
}