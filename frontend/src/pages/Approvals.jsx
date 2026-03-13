import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, CheckCircle, RefreshCw } from 'lucide-react';
import { socket } from '../socket';
import MagicButton from '../components/MagicButton';
import { api } from '../lib/api';

export default function Approvals() {
  const [approvals, setApprovals]   = useState([]);
  const [loading, setLoading]       = useState(true);
  const [processing, setProcessing] = useState({}); // id → 'approving'|'rejecting'|'done'
  const [reasons, setReasons]       = useState({});  // id → rejection reason string

  async function fetchApprovals() {
    try {
      const d = await api.approvals('pending');
      setApprovals(d.approvals || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    fetchApprovals();
    socket.on('approval_needed', fetchApprovals);
    return () => socket.off('approval_needed');
  }, []);

  async function handleApprove(approval) {
    setProcessing(p => ({ ...p, [approval.id]: 'approving' }));
    try {
      await api.approve(approval.id);
      setProcessing(p => ({ ...p, [approval.id]: 'done' }));
      // Remove from list after showing success state
      setTimeout(() => {
        setApprovals(prev => prev.filter(a => a.id !== approval.id));
        setProcessing(p => { const n = { ...p }; delete n[approval.id]; return n; });
      }, 2500);
    } catch (err) {
      console.error('Approve failed:', err.message);
      setProcessing(p => ({ ...p, [approval.id]: null }));
    }
  }

  async function handleReject(approval) {
    setProcessing(p => ({ ...p, [approval.id]: 'rejecting' }));
    try {
      await api.reject(approval.id, reasons[approval.id] || 'Rejected by operator');
      setApprovals(prev => prev.filter(a => a.id !== approval.id));
    } catch (err) {
      console.error('Reject failed:', err.message);
      setProcessing(p => ({ ...p, [approval.id]: null }));
    }
  }

  if (loading) {
    return (
      <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        className="relative z-10 pt-32 px-10 max-w-4xl mx-auto flex items-center justify-center h-[60vh]">
        <p className="text-gray-500 font-mono uppercase tracking-widest animate-pulse">Loading...</p>
      </motion.main>
    );
  }

  if (approvals.length === 0) {
    return (
      <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        className="relative z-10 pt-32 px-10 max-w-4xl mx-auto flex flex-col items-center justify-center h-[60vh] gap-4">
        <CheckCircle className="text-green-500 w-12 h-12 opacity-50" />
        <p className="text-gray-500 font-mono uppercase tracking-widest">No pending alert dispatches.</p>
        <button onClick={fetchApprovals} className="text-xs text-gray-600 hover:text-gray-400 flex items-center gap-2 transition-colors">
          <RefreshCw size={12} /> Refresh
        </button>
      </motion.main>
    );
  }

  return (
    <motion.main initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="relative z-10 pt-32 px-10 max-w-4xl mx-auto pb-20">

      <div className="flex items-center gap-4 mb-10">
        <ShieldAlert className="text-amber-500 w-8 h-8 drop-shadow-[0_0_15px_rgba(245,158,11,0.5)]" />
        <h1 className="text-3xl font-bold tracking-tighter">Pending Alert Reports</h1>
        <span className="bg-red-500/20 border border-red-500/30 text-red-400 text-xs px-2 py-1 rounded-full font-bold font-mono">
          {approvals.length}
        </span>
        <button onClick={fetchApprovals} className="ml-auto text-gray-500 hover:text-white transition-colors">
          <RefreshCw size={16} />
        </button>
      </div>

      <AnimatePresence mode="popLayout">
        {approvals.map(approval => {
          const state     = processing[approval.id];
          const isDone    = state === 'done';
          const isWorking = state === 'approving' || state === 'rejecting';
          const snap      = approval.metrics_snapshot || {};
          const conf      = approval.confidence ? (approval.confidence * 100).toFixed(0) : '—';

          return (
            <motion.div key={approval.id} layout
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, filter: 'blur(10px)' }}
              className="mb-6 metal-container-static w-full" style={{ '--m-radius': '1.5rem', '--m-border': '1px' }}>
              <div className={`metal-surface p-8 transition-colors ${isDone ? 'bg-green-500/5' : ''}`}>

                {/* Success state */}
                {isDone ? (
                  <div className="flex flex-col items-center py-8 gap-4">
                    <CheckCircle className="text-green-500 w-12 h-12 animate-pulse drop-shadow-[0_0_15px_rgba(34,197,94,0.5)]" />
                    <h2 className="text-2xl font-bold text-green-400 tracking-tighter">Dispatching Alert Report</h2>
                    <p className="text-gray-400 mt-2 font-mono text-sm">Incident report dispatched for {approval.service_id}</p>
                  </div>
                ) : (
                  <>
                    {/* Header */}
                    <div className="mb-6">
                      <span className="bg-amber-500/10 border border-amber-500/20 text-amber-500 text-xs px-3 py-1.5 rounded-full uppercase tracking-widest font-bold">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse mr-2" />
                        Approval Required • {new Date(approval.created_at).toLocaleTimeString()}
                      </span>
                      <h2 className="text-2xl font-bold mt-6 tracking-tighter">
                        Proposed Action: {(approval.action || 'restart').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                      </h2>
                      <p className="text-sm text-gray-400 font-mono mt-2 bg-white/5 inline-block px-3 py-1 rounded">
                        Target: <span className="text-white">{approval.service_id}</span>
                        {' '}| Confidence: <span className="text-amber-500">{conf}%</span>
                        {' '}| Severity: <span className={approval.incident_severity === 'critical' ? 'text-red-400' : 'text-amber-400'}>
                          {approval.incident_severity}
                        </span>
                      </p>
                    </div>

                    {/* Why section */}
                    <div className="mb-8 metal-container-static" style={{ '--m-radius': '0.75rem', '--m-border': '1px' }}>
                      <div className="metal-surface p-6">
                        <h3 className="text-xs text-gray-500 uppercase tracking-widest mb-3 font-mono">Why this action?</h3>
                        <p className="text-gray-300 italic border-l-2 border-indigo/50 pl-4 bg-gradient-to-r from-indigo/5 to-transparent py-2">
                          "Metrics indicate likely SLA degradation with {conf}% confidence. Approving will
                          dispatch the structured incident report and escalation alert."
                        </p>
                      </div>
                    </div>

                    {/* Metrics snapshot bars */}
                    {Object.keys(snap).length > 0 && (
                      <div className="mb-10 space-y-4 font-mono text-sm bg-black/50 p-6 rounded-xl border border-white/5">
                        <h3 className="text-xs text-gray-500 uppercase tracking-widest mb-4">Metrics at Prediction Time</h3>
                        {Object.entries(snap).map(([k, v]) => {
                          const pct   = typeof v === 'number' ? Math.min(v, 100) : 0;
                          const isHigh = typeof v === 'number' && v > 80;
                          return (
                            <div key={k} className={`flex items-center gap-4 ${isHigh ? 'text-critical' : 'text-green-500'}`}>
                              <span className="w-36 text-gray-400">{k}</span>
                              <div className="flex-1 h-3 bg-white/5 rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${isHigh ? 'bg-critical shadow-[0_0_10px_rgba(239,68,68,0.5)]' : 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]'}`}
                                  style={{ width: `${pct}%` }} />
                              </div>
                              <span>{typeof v === 'number' ? v.toFixed(1) : v}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Action bar */}
                    <div className="flex items-center gap-4 border-t border-white/10 pt-6">
                      <input type="text"
                        value={reasons[approval.id] || ''}
                        onChange={e => setReasons(r => ({ ...r, [approval.id]: e.target.value }))}
                        placeholder="Rejection reason (optional)"
                        className="bg-black/50 border border-white/10 rounded-full px-5 py-3 flex-1 text-sm focus:outline-none focus:border-indigo transition-colors text-white placeholder:text-gray-500" />

                      <button onClick={() => handleReject(approval)} disabled={isWorking}
                        className="metal-container group" style={{ '--m-radius': '9999px', '--m-border': '1px' }}>
                        <div className="metal-surface px-6 py-3 font-bold text-sm text-gray-300 transition-colors group-hover:bg-[#151515] group-hover:text-white">
                          {state === 'rejecting' ? 'Rejecting...' : 'Reject'}
                        </div>
                      </button>

                      <MagicButton onClick={() => handleApprove(approval)} disabled={isWorking}>
                        <span className="font-bold text-sm text-white drop-shadow-[0_0_8px_rgba(99,102,241,0.8)]">
                          {state === 'approving' ? 'Dispatching...' : 'Approve & Dispatch'}
                        </span>
                      </MagicButton>
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </motion.main>
  );
}