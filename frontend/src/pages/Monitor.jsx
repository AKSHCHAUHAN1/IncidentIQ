import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Trash2, Globe, RefreshCw, AlertTriangle, CheckCircle, Clock, Wifi, WifiOff, Shield } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../lib/api';
import { socket } from '../socket';

// Status pill
const StatusBadge = ({ status }) => {
  const cfg = {
    up:       { color: 'text-green-400 border-green-500/30 bg-green-500/10', icon: <CheckCircle size={12} />, label: 'UP' },
    degraded: { color: 'text-amber-400 border-amber-500/30 bg-amber-500/10', icon: <AlertTriangle size={12} />, label: 'DEGRADED' },
    down:     { color: 'text-red-400 border-red-500/30 bg-red-500/10',       icon: <WifiOff size={12} />,       label: 'DOWN' },
    unknown:  { color: 'text-gray-400 border-gray-500/30 bg-gray-500/10',    icon: <Clock size={12} />,         label: 'PROBING' },
  }[status] || { color: 'text-gray-400 border-gray-500/30 bg-gray-500/10', icon: <Clock size={12} />, label: 'UNKNOWN' };

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-mono font-bold ${cfg.color}`}>
      {cfg.icon} {cfg.label}
    </span>
  );
};

// Sparkline for a single site — auto-refreshes
const SiteSparkline = ({ siteId, refreshKey }) => {
  const [data, setData] = useState([]);

  const fetchData = useCallback(() => {
    api.siteMetrics(siteId, 30)
      .then(d => {
        if (d.metrics?.length) {
          setData(d.metrics.map(m => ({
            time: new Date(m.time).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            rt:   Math.round(m.response_time_ms || m.response_time || m.ttfb_ms || m.latency || 0),
          })));
        }
      })
      .catch(() => {});
  }, [siteId]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshKey]);

  // Auto-refresh sparkline every 30s
  useEffect(() => {
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (data.length < 2) return <div className="h-12 flex items-center text-gray-600 text-xs font-mono">Collecting data...</div>;

  return (
    <ResponsiveContainer width="100%" height={48}>
      <LineChart data={data}>
        <Line type="monotone" dataKey="rt" stroke="#6366f1" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        <Tooltip
          contentStyle={{ background: 'rgba(10,12,16,0.95)', border: '1px solid rgba(255,255,255,0.1)', fontSize: 10 }}
          formatter={v => [`${v}ms`, 'Response']}
          labelFormatter={() => ''}
        />
      </LineChart>
    </ResponsiveContainer>
  );
};

// Single site card
const SiteCard = ({ site, onRemove, isDeleting = false, refreshKey }) => {
  const [expanded, setExpanded] = useState(false);

  const statusColor = { up: 'border-green-500/20', degraded: 'border-amber-500/20', down: 'border-red-500/30 bg-red-500/5', unknown: 'border-white/5' };

  return (
    <motion.div layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}
      className={`replica-3d-item p-5 cursor-pointer transition-all ${statusColor[site.last_status] || 'border-white/5'}`}
      onClick={() => setExpanded(e => !e)}>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Globe size={16} className="text-indigo-400 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold text-white text-sm truncate">{site.name}</p>
            <p className="text-xs text-gray-500 font-mono truncate">{site.url}</p>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0 ml-3">
          <StatusBadge status={site.last_status} />
          {site.last_response_ms && (
            <span className={`text-xs font-mono ${site.last_response_ms > 2000 ? 'text-red-400' : site.last_response_ms > 800 ? 'text-amber-400' : 'text-green-400'}`}>
              {Math.round(site.last_response_ms)}ms
            </span>
          )}
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onRemove(site.id); }}
            disabled={isDeleting}
            className={`transition-colors p-1 ${isDeleting ? 'text-gray-700 cursor-not-allowed' : 'text-gray-600 hover:text-red-400'}`}
          >
            {isDeleting ? <RefreshCw size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="mt-4 pt-4 border-t border-white/5 overflow-hidden">
            <div className="grid grid-cols-2 gap-4 mb-4 font-mono text-xs">
              <div>
                <span className="text-gray-500">Status</span>
                <p className="font-bold text-base text-white">
                  {(site.last_status || 'unknown').toUpperCase()}
                </p>
              </div>
              <div>
                <span className="text-gray-500">Last probed</span>
                <p className="font-bold text-base text-white text-xs">
                  {site.last_probed ? new Date(site.last_probed).toLocaleTimeString() : '—'}
                </p>
              </div>
            </div>
            <p className="text-xs text-gray-500 font-mono mb-2">Response time (last 30 min)</p>
            <SiteSparkline siteId={site.id} refreshKey={refreshKey} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default function Monitor() {
  const [sites, setSites]       = useState([]);
  const [url, setUrl]           = useState('');
  const [name, setName]         = useState('');
  const [loading, setLoading]   = useState(true);
  const [adding, setAdding]     = useState(false);
  const [error, setError]       = useState('');
  const [removeError, setRemoveError] = useState('');
  const [deletingIds, setDeletingIds] = useState(new Set());
  const [refreshKey, setRefreshKey]   = useState(0);
  const intervalRef             = useRef(null);
  const statusRef               = useRef(null);

  async function fetchSites() {
    try {
      const d = await api.sites();
      setSites(d.sites || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }

  // Poll status for live updates between probe cycles
  const pollStatus = useCallback(async () => {
    try {
      const d = await api.sitesStatus();
      if (d.sites?.length) {
        setSites(prev => {
          const statusMap = new Map(d.sites.map(s => [s.id, s]));
          return prev.map(site => {
            const fresh = statusMap.get(site.id);
            if (fresh) {
              return {
                ...site,
                last_status: fresh.status || site.last_status,
                last_response_ms: fresh.ttfb_ms || site.last_response_ms,
                last_probed: fresh.last_probed || site.last_probed,
              };
            }
            return site;
          });
        });
        // Bump refreshKey so expanded sparklines re-fetch
        setRefreshKey(k => k + 1);
      }
    } catch (err) { console.error('[Monitor] status poll error:', err); }
  }, []);

  useEffect(() => {
    fetchSites();
    intervalRef.current = setInterval(fetchSites, 30_000); // full refresh every probe cycle
    statusRef.current = setInterval(pollStatus, 15_000);    // status poll every 15s

    // Listen for real-time probe updates via socket
    const handleMetricsUpdate = () => {
      pollStatus();
    };
    const handleNewPrediction = () => {
      pollStatus();
    };

    socket.on('metrics_update', handleMetricsUpdate);
    socket.on('new_prediction', handleNewPrediction);
    socket.on('probe_complete', handleMetricsUpdate);

    return () => {
      clearInterval(intervalRef.current);
      clearInterval(statusRef.current);
      socket.off('metrics_update', handleMetricsUpdate);
      socket.off('new_prediction', handleNewPrediction);
      socket.off('probe_complete', handleMetricsUpdate);
    };
  }, [pollStatus]);

  async function handleAdd(e) {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    setError('');
    try {
      const d = await api.addSite(url.trim(), name.trim() || undefined);
      if (d.error) { setError(d.error); return; }
      setUrl(''); setName('');
      await fetchSites();
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(id) {
    if (deletingIds.has(id)) return;

    setRemoveError('');
    setDeletingIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

    try {
      const d = await api.removeSite(id);
      if (!d?.success) {
        throw new Error(d?.error || 'Failed to remove website');
      }

      setSites(prev => prev.filter(site => site.id !== id));
      await fetchSites();
    } catch (err) {
      setRemoveError(err.message || 'Failed to remove website');
    } finally {
      setDeletingIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const upCount       = sites.filter(s => s.last_status === 'up').length;
  const degradedCount = sites.filter(s => s.last_status === 'degraded').length;
  const downCount     = sites.filter(s => s.last_status === 'down').length;

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="relative z-10 pt-32 px-10 max-w-5xl mx-auto pb-20">

      <div className="flex items-center justify-between mb-2">
        <h1 className="text-3xl font-bold tracking-tighter">Website Monitor</h1>
        <button onClick={() => { fetchSites(); pollStatus(); }} className="text-gray-500 hover:text-white transition-colors">
          <RefreshCw size={16} />
        </button>
      </div>
      <p className="text-gray-400 mb-10 tracking-tighter">
        Add any URL — IncidentIQ probes it every 30s and predicts SLA risk before downtime.
      </p>

      {/* URL input */}
      <div className="metal-container-static mb-8 w-full" style={{ '--m-radius': '1rem', '--m-border': '1px' }}>
        <div className="metal-surface p-6">
          <h3 className="text-sm font-mono text-gray-400 uppercase tracking-wider mb-4">Add a website to monitor</h3>
          <form onSubmit={handleAdd} className="flex gap-3">
            <input type="text" value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://your-website.com"
              className="flex-1 bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-indigo-500 transition-colors font-mono" />
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="Display name (optional)"
              className="w-48 bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-indigo-500 transition-colors" />
            <button type="submit" disabled={adding || !url.trim()}
              className="metal-container group disabled:opacity-50" style={{ '--m-radius': '0.75rem', '--m-border': '1px' }}>
              <div className="metal-surface px-5 py-3 flex items-center gap-2 font-bold text-sm text-white transition-colors group-hover:bg-[#151515]">
                {adding ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                {adding ? 'Adding...' : 'Monitor'}
              </div>
            </button>
          </form>
          {error && <p className="text-red-400 text-xs font-mono mt-3">{error}</p>}
          <p className="text-gray-600 text-xs font-mono mt-3">
            Works with any public URL. The probe collects response time, SSL expiry, availability and error rate.
          </p>
        </div>
      </div>

      {/* Summary stats */}
      {sites.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: 'Sites Up',      value: upCount,       color: 'text-green-400', icon: <Wifi size={14} /> },
            { label: 'Degraded',      value: degradedCount, color: 'text-amber-400', icon: <AlertTriangle size={14} /> },
            { label: 'Down / Error',  value: downCount,     color: 'text-red-400',   icon: <WifiOff size={14} /> },
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
      )}

      {/* Sites list */}
      {loading ? (
        <p className="text-gray-500 font-mono animate-pulse">Loading sites...</p>
      ) : sites.length === 0 ? (
        <div className="tech-border bg-black/40 rounded-2xl p-16 flex flex-col items-center gap-4 text-center">
          <Globe size={32} className="text-gray-600" />
          <p className="text-gray-400 font-mono">No sites monitored yet.</p>
          <p className="text-gray-600 text-sm">Paste any URL above — the first probe runs within 30 seconds.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {removeError && <p className="text-red-400 text-xs font-mono">{removeError}</p>}
          <AnimatePresence>
            {sites.map(site => (
              <SiteCard key={site.id} site={site} onRemove={handleRemove} isDeleting={deletingIds.has(site.id)} refreshKey={refreshKey} />
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* How it works */}
      <div className="mt-12 tech-border bg-black/20 rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <Shield size={14} className="text-indigo-400" />
          <h3 className="text-xs font-mono text-gray-400 uppercase tracking-wider">How it works</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 font-mono text-xs text-gray-500">
          {[
            ["1. Probe",     "IncidentIQ hits your URL every 30s, measuring TTFB, DNS, SSL days, and availability"],
            ["2. Ingest",    "Raw metrics flow into TimescaleDB via Redis stream — same pipeline as internal services"],
            ["3. Predict",   "LSTM forecasts the next 30 minutes. Isolation Forest flags anomalous performance shifts"],
            ["4. Alert", "When confidence is high, IncidentIQ generates a structured incident report and alert"],
          ].map(([title, desc]) => (
            <div key={title} className="replica-3d-item p-3">
              <p className="text-indigo-400 font-bold mb-1">{title}</p>
              <p>{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </motion.main>
  );
}