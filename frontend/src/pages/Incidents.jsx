import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, Loader, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../lib/api';

export default function Incidents() {
  const [searchTerm, setSearchTerm]             = useState('');
  const [selectedIncident, setSelectedIncident] = useState(null);
  const [incidents, setIncidents]               = useState([]);
  const [loading, setLoading]                   = useState(true);

  useEffect(() => {
    api.incidents({ limit: 100 })
      .then(d => setIncidents(d.incidents || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filteredIncidents = useMemo(() =>
    incidents.filter(inc =>
      inc.service_id?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      inc.id?.toLowerCase().includes(searchTerm.toLowerCase())
    ), [incidents, searchTerm]);

  // Map DB fields → display
  const displayStatus = (inc) => {
    if (inc.remediation_status === 'success' || inc.status === 'prevented') return 'Success';
    if (inc.remediation_status === 'failed'  || inc.status === 'occurred')  return 'Failed';
    return 'Pending';
  };

  // ── Exact reference replica status pills ─────────────────────
  const StatusPill = ({ status }) => {
    if (status === 'Pending') return (
      <div className="status-badge-ref status-badge-warning">
        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
          style={{ width: 14, height: 14, display: "flex", originX: 0.5, originY: 0.5 }} className="status-icon relative z-10">
          <Loader size={14} />
        </motion.div>
        <span className="relative z-10 tracking-wide">Pending</span>
      </div>
    );
    if (status === 'Success') return (
      <div className="status-badge-ref status-badge-success">
        <CheckCircle2 size={14} className="status-icon relative z-10" />
        <span className="relative z-10 tracking-wide">Success</span>
      </div>
    );
    return (
      <div className="status-badge-ref status-badge-critical">
        <XCircle size={14} className="status-icon relative z-10" />
        <span className="relative z-10 tracking-wide">Failed</span>
      </div>
    );
  };

  const tableVars = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.05 } } };
  const rowVars   = { hidden: { opacity: 0, x: -10 }, show: { opacity: 1, x: 0 } };

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="relative z-10 pt-32 px-10 max-w-7xl mx-auto flex">

      <div className={`flex-1 transition-all duration-500 ${selectedIncident ? 'pr-[400px]' : ''}`}>
        <div className="flex justify-between items-end mb-8">
          <h1 className="text-3xl font-bold tracking-tighter">Incident Registry</h1>
          <div className="relative group metal-container-static w-72" style={{ '--m-radius': '9999px', '--m-border': '1px' }}>
            <div className="metal-surface flex items-center pl-4 pr-4 py-2.5">
              <Search className="text-gray-500 w-[18px] h-[18px] transition-colors group-focus-within:text-white shrink-0" />
              <input type="text" value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
                placeholder="Search by service or ID..."
                className="bg-transparent border-none outline-none pl-3 text-sm w-full text-white placeholder:text-gray-500 focus:ring-0" />
            </div>
          </div>
        </div>

        <div className="tech-border bg-black/40 backdrop-blur-xl rounded-2xl overflow-hidden shadow-2xl border-white/5">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#0f1117] text-gray-400 font-mono text-xs uppercase tracking-wider border-b border-white/5">
              <tr>
                <th className="p-5 font-medium">Status</th>
                <th className="p-5 font-medium">Incident ID</th>
                <th className="p-5 font-medium">Service Name</th>
                <th className="p-5 font-medium text-right">Severity</th>
              </tr>
            </thead>
            <motion.tbody variants={tableVars} initial="hidden" animate="show" className="divide-y divide-white/5">
              {loading ? (
                <tr><td colSpan="4" className="text-center py-10 text-gray-500 font-mono">Loading incidents...</td></tr>
              ) : filteredIncidents.length === 0 ? (
                <tr><td colSpan="4" className="text-center py-10 text-gray-500">
                  {searchTerm ? `No incidents found matching "${searchTerm}"` : 'No incidents recorded — system healthy 🎉'}
                </td></tr>
              ) : filteredIncidents.map(inc => (
                <motion.tr variants={rowVars} key={inc.id} onClick={() => setSelectedIncident(inc)}
                  className="hover:bg-white/5 cursor-pointer transition-colors group">
                  <td className="p-4"><StatusPill status={displayStatus(inc)} /></td>
                  <td className="p-4 font-mono text-gray-300 group-hover:text-white transition-colors text-xs">{inc.id}</td>
                  <td className="p-4 text-gray-300">{inc.service_id}</td>
                  <td className="p-4 text-right">
                    <span className={`px-2 py-1 rounded text-xs border ${
                      inc.severity === 'critical'
                        ? 'bg-red-500/10 text-red-500 border-red-500/20'
                        : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                    }`}>{inc.severity}</span>
                  </td>
                </motion.tr>
              ))}
            </motion.tbody>
          </table>
        </div>
      </div>

      {/* Slide-over — exact design from your original */}
      <AnimatePresence>
        {selectedIncident && (
          <motion.div
            initial={{ x: '100%', opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 w-[400px] h-full bg-[#0a0c10]/95 backdrop-blur-2xl border-l border-white/10 z-50 p-8 overflow-y-auto shadow-[-20px_0_50px_rgba(0,0,0,0.5)]">
            <button onClick={() => setSelectedIncident(null)}
              className="absolute top-6 right-6 text-gray-500 hover:text-white bg-white/5 rounded-full p-2 transition-all">
              <X className="w-4 h-4" />
            </button>
            <h2 className="text-2xl font-bold mt-10 mb-2 tracking-tighter text-white font-mono">{selectedIncident.id}</h2>
            <p className="text-sm text-gray-400 font-mono border-b border-white/10 pb-6 mb-6">
              {selectedIncident.service_id} • {new Date(selectedIncident.predicted_at).toLocaleString()}
            </p>
            <div className="space-y-6">
              <div>
                <h4 className="text-xs text-gray-500 uppercase tracking-widest font-mono mb-3">Current Status</h4>
                <StatusPill status={displayStatus(selectedIncident)} />
              </div>
              <div>
                <h4 className="text-xs text-gray-500 uppercase tracking-widest font-mono mb-3">Details</h4>
                <div className="replica-3d-item p-4 space-y-2 font-mono text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Severity</span>
                    <span className={selectedIncident.severity === 'critical' ? 'text-red-400' : 'text-amber-400'}>{selectedIncident.severity}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Confidence</span>
                    <span className="text-white">{selectedIncident.confidence ? `${(selectedIncident.confidence * 100).toFixed(1)}%` : '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Action</span>
                    <span className="text-white">{selectedIncident.remediation_action || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Auto-executed</span>
                    <span className={selectedIncident.auto_executed ? 'text-green-400' : 'text-gray-400'}>
                      {selectedIncident.auto_executed ? 'Yes' : 'No'}
                    </span>
                  </div>
                </div>
              </div>
              {selectedIncident.metrics_snapshot && (
                <div>
                  <h4 className="text-xs text-gray-500 uppercase tracking-widest font-mono mb-3">Metrics Snapshot</h4>
                  <div className="replica-3d-item p-4 space-y-2 font-mono text-sm">
                    {Object.entries(selectedIncident.metrics_snapshot).map(([k, v]) => (
                      <div key={k} className="flex justify-between">
                        <span className="text-gray-500">{k}</span>
                        <span className="text-white">{typeof v === 'number' ? v.toFixed(2) : v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.main>
  );
}