import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, Loader, CheckCircle2, XCircle, MinusCircle, RefreshCw, Check } from 'lucide-react';
import { api } from '../lib/api';
import { socket } from '../socket';

export default function Incidents() {
  const [searchTerm, setSearchTerm]               = useState('');
  const [selectedIncident, setSelectedIncident]   = useState(null);
  const [incidents, setIncidents]                 = useState([]);
  const [loading, setLoading]                     = useState(true);
  const [processing, setProcessing]               = useState({}); // id → 'action_taken'|'ignoring'|'done'

  async function fetchIncidents() {
    setLoading(true);
    try {
      const d = await api.incidents({ limit: 100 });
      setIncidents(d.incidents || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    fetchIncidents();

    // Listen for new incidents and alerts via socket
    const handleNewAlert = () => fetchIncidents();
    const handleNewPrediction = () => fetchIncidents();

    socket.on('new_alert', handleNewAlert);
    socket.on('new_prediction', handleNewPrediction);

    // Refresh incidents periodically
    const interval = setInterval(fetchIncidents, 30_000);

    return () => {
      socket.off('new_alert', handleNewAlert);
      socket.off('new_prediction', handleNewPrediction);
      clearInterval(interval);
    };
  }, []);

  // Keep selected incident in sync with list updates
  useEffect(() => {
    if (selectedIncident) {
      const updated = incidents.find(i => i.id === selectedIncident.id);
      if (updated) setSelectedIncident(updated);
    }
  }, [incidents]);

  const filteredIncidents = useMemo(() =>
    incidents.filter(inc =>
      (inc.url || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (inc.service_id || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (inc.id || '').toLowerCase().includes(searchTerm.toLowerCase())
    ), [incidents, searchTerm]);

  const displayStatus = (inc) => {
    if (inc.status === 'action_taken') return 'Action Taken';
    if (inc.status === 'ignored') return 'Ignored';
    return 'Open';
  };

  async function handleActionTaken(incident) {
    setProcessing(p => ({ ...p, [incident.id]: 'action_taken' }));
    try {
      await api.patchIncident(incident.id, 'action_taken');
      setProcessing(p => ({ ...p, [incident.id]: 'done' }));
      // Update in list
      setIncidents(prev => prev.map(i =>
        i.id === incident.id ? { ...i, status: 'action_taken' } : i
      ));
      if (selectedIncident?.id === incident.id) {
        setSelectedIncident(prev => ({ ...prev, status: 'action_taken' }));
      }
      setTimeout(() => {
        setProcessing(p => { const n = { ...p }; delete n[incident.id]; return n; });
      }, 1500);
    } catch (err) {
      console.error('Action taken failed:', err.message);
      setProcessing(p => ({ ...p, [incident.id]: null }));
    }
  }

  async function handleIgnore(incident) {
    setProcessing(p => ({ ...p, [incident.id]: 'ignoring' }));
    try {
      await api.patchIncident(incident.id, 'ignored');
      // Update in list
      setIncidents(prev => prev.map(i =>
        i.id === incident.id ? { ...i, status: 'ignored' } : i
      ));
      if (selectedIncident?.id === incident.id) {
        setSelectedIncident(prev => ({ ...prev, status: 'ignored' }));
      }
      setProcessing(p => { const n = { ...p }; delete n[incident.id]; return n; });
    } catch (err) {
      console.error('Ignore failed:', err.message);
      setProcessing(p => ({ ...p, [incident.id]: null }));
    }
  }

  const StatusPill = ({ status }) => {
    if (status === 'Open') return (
      <div className="status-badge-ref status-badge-warning">
        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
          style={{ width: 14, height: 14, display: "flex", originX: 0.5, originY: 0.5 }} className="status-icon relative z-10">
          <Loader size={14} />
        </motion.div>
        <span className="relative z-10 tracking-wide">Open</span>
      </div>
    );
    if (status === 'Action Taken') return (
      <div className="status-badge-ref status-badge-success">
        <CheckCircle2 size={14} className="status-icon relative z-10" />
        <span className="relative z-10 tracking-wide">Action Taken</span>
      </div>
    );
    return (
      <div className="status-badge-ref status-badge-critical">
        <MinusCircle size={14} className="status-icon relative z-10" />
        <span className="relative z-10 tracking-wide">Ignored</span>
      </div>
    );
  };

  const tableVars = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.05 } } };
  const rowVars   = { hidden: { opacity: 0, x: -10 }, show: { opacity: 1, x: 0 } };

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="relative z-10 pt-32 px-10 max-w-7xl mx-auto flex">

      <div className={`flex-1 transition-all duration-500 ${selectedIncident ? 'pr-[440px]' : ''}`}>
        <div className="flex justify-between items-end mb-8">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tighter">Incident Registry</h1>
            <button onClick={fetchIncidents} className="text-gray-500 hover:text-white transition-colors">
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="relative group metal-container-static w-72" style={{ '--m-radius': '9999px', '--m-border': '1px' }}>
            <div className="metal-surface flex items-center pl-4 pr-4 py-2.5">
              <Search className="text-gray-500 w-[18px] h-[18px] transition-colors group-focus-within:text-white shrink-0" />
              <input type="text" value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                placeholder="Search by URL or ID..."
                className="bg-transparent border-none outline-none pl-3 text-sm w-full text-white placeholder:text-gray-500 focus:ring-0" />
            </div>
          </div>
        </div>

        <div className="tech-border bg-black/40 backdrop-blur-xl rounded-2xl overflow-hidden shadow-2xl border-white/5">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#0f1117] text-gray-400 font-mono text-xs uppercase tracking-wider border-b border-white/5">
              <tr>
                <th className="p-5 font-medium">Status</th>
                <th className="p-5 font-medium">URL</th>
                <th className="p-5 font-medium">Type</th>
                <th className="p-5 font-medium">Confidence</th>
                <th className="p-5 font-medium">Started</th>
                <th className="p-5 font-medium text-right">Duration</th>
              </tr>
            </thead>
            <motion.tbody key={loading ? 'loading' : 'loaded'} variants={tableVars} initial="hidden" animate="show" className="divide-y divide-white/5">
              {loading ? (
                <tr><td colSpan="6" className="text-center py-10 text-gray-500 font-mono animate-pulse">Loading incidents...</td></tr>
              ) : filteredIncidents.length === 0 ? (
                <tr><td colSpan="6" className="text-center py-10 text-gray-500">
                  {searchTerm ? `No incidents matching "${searchTerm}"` : 'No incidents recorded — system healthy'}
                </td></tr>
              ) : filteredIncidents.map(inc => (
                <motion.tr variants={rowVars} key={inc.id} onClick={() => setSelectedIncident(inc)}
                  className={`hover:bg-white/5 cursor-pointer transition-colors group ${selectedIncident?.id === inc.id ? 'bg-white/5' : ''}`}>
                  <td className="p-4"><StatusPill status={displayStatus(inc)} /></td>
                  <td className="p-4 text-gray-300 font-mono text-xs truncate max-w-[200px]">{inc.url || inc.service_id}</td>
                  <td className="p-4 text-gray-300 text-xs">{(inc.anomaly_type || inc.root_cause || '—').replace(/_/g, ' ')}</td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded text-xs border font-mono ${
                      inc.confidence >= 0.9
                        ? 'bg-red-500/10 text-red-400 border-red-500/20'
                        : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                    }`}>{inc.confidence ? (inc.confidence * 100).toFixed(0) + '%' : '—'}</span>
                  </td>
                  <td className="p-4 text-gray-400 text-xs font-mono">{inc.started_at ? new Date(inc.started_at).toLocaleString() : '—'}</td>
                  <td className="p-4 text-right text-gray-400 text-xs font-mono">{inc.duration_min ? `${inc.duration_min}m` : '—'}</td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        </div>
      </div>

      {/* Slide-over panel */}
      <AnimatePresence>
        {selectedIncident && (
          <motion.div
            initial={{ x: '100%', opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 w-[440px] h-full bg-[#0a0c10]/95 backdrop-blur-2xl border-l border-white/10 z-50 p-8 overflow-y-auto shadow-[-20px_0_50px_rgba(0,0,0,0.5)]">

            <button onClick={() => setSelectedIncident(null)}
              className="absolute top-6 right-6 text-gray-500 hover:text-white bg-white/5 rounded-full p-2 transition-all">
              <X className="w-4 h-4" />
            </button>

            <h2 className="text-2xl font-bold mt-10 mb-2 tracking-tighter text-white font-mono">{selectedIncident.id}</h2>
            <p className="text-sm text-gray-400 font-mono border-b border-white/10 pb-6 mb-6">
              {selectedIncident.url || selectedIncident.service_id} • {selectedIncident.started_at ? new Date(selectedIncident.started_at).toLocaleString() : '—'}
            </p>

            <div className="space-y-6">
              <div>
                <h4 className="text-xs text-gray-500 uppercase tracking-widest font-mono mb-3">Current Status</h4>
                <StatusPill status={displayStatus(selectedIncident)} />
              </div>

              <div>
                <h4 className="text-xs text-gray-500 uppercase tracking-widest font-mono mb-3">Details</h4>
                <div className="replica-3d-item p-4 space-y-2 font-mono text-sm">
                  {[
                    ["URL",          selectedIncident.url || selectedIncident.service_id],
                    ["Anomaly Type", (selectedIncident.anomaly_type || selectedIncident.root_cause || '—').replace(/_/g, ' ')],
                    ["Severity",     <span className={selectedIncident.severity === 'critical' ? 'text-red-400' : 'text-amber-400'}>{selectedIncident.severity}</span>],
                    ["Confidence",   selectedIncident.confidence ? `${(selectedIncident.confidence * 100).toFixed(1)}%` : '—'],
                    ["Duration",     selectedIncident.duration_min ? `${selectedIncident.duration_min} min` : 'Ongoing'],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="text-gray-500">{k}</span>
                      <span className="text-white">{v}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Metrics snapshot */}
              {selectedIncident.metrics_snapshot && (
                <div>
                  <h4 className="text-xs text-gray-500 uppercase tracking-widest font-mono mb-3">Metrics Snapshot</h4>
                  <div className="replica-3d-item p-4 space-y-2 font-mono text-sm">
                    {Object.entries(selectedIncident.metrics_snapshot).map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <span className="text-gray-500">{k}</span>
                        <span className={typeof v === 'number' && v > 80 ? 'text-red-400' : 'text-white'}>
                          {typeof v === 'number' ? v.toFixed(2) : v}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Action buttons — only for 'open' incidents */}
              {selectedIncident.status === 'open' && (() => {
                const state     = processing[selectedIncident.id];
                const isDone    = state === 'done';
                const isWorking = state === 'action_taken' || state === 'ignoring';

                if (isDone) {
                  return (
                    <div className="flex flex-col items-center py-6 gap-3 border-t border-white/10">
                      <CheckCircle2 className="text-green-500 w-10 h-10 animate-pulse drop-shadow-[0_0_15px_rgba(34,197,94,0.5)]" />
                      <p className="text-green-400 font-bold tracking-tighter">Acknowledged</p>
                    </div>
                  );
                }

                return (
                  <div className="flex items-center gap-3 pt-6 border-t border-white/10">
                    <button
                      onClick={() => handleIgnore(selectedIncident)}
                      disabled={isWorking}
                      className="metal-container group disabled:opacity-50 flex-1"
                      style={{ '--m-radius': '0.75rem', '--m-border': '1px' }}
                    >
                      <div className="metal-surface px-5 py-3 flex items-center justify-center gap-2 font-bold text-sm text-gray-300 transition-colors group-hover:bg-[#151515] group-hover:text-white">
                        <X size={14} />
                        {state === 'ignoring' ? 'Ignoring...' : 'Ignore'}
                      </div>
                    </button>

                    <button
                      onClick={() => handleActionTaken(selectedIncident)}
                      disabled={isWorking}
                      className="metal-container group disabled:opacity-50 flex-1"
                      style={{ '--m-radius': '0.75rem', '--m-border': '1px' }}
                    >
                      <div className="metal-surface px-5 py-3 flex items-center justify-center gap-2 font-bold text-sm text-green-400 transition-colors group-hover:bg-[#151515] group-hover:text-green-300">
                        <Check size={14} />
                        {state === 'action_taken' ? 'Processing...' : 'Action Taken'}
                      </div>
                    </button>
                  </div>
                );
              })()}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.main>
  );
}