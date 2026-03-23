import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, CheckCircle, RefreshCw, Check, X } from 'lucide-react';
import { socket } from '../socket';
import { api } from '../lib/api';

export default function Approvals() {
  const [approvals, setApprovals]   = useState([]);
  const [loading, setLoading]       = useState(true);
  const [processing, setProcessing] = useState({}); // id → 'action_taken'|'ignoring'|'done'

  async function fetchApprovals() {
    try {
      const d = await api.approvals();
      setApprovals(d.approvals || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    fetchApprovals();
    socket.on('new_prediction', fetchApprovals);
    return () => socket.off('new_prediction');
  }, []);

  async function handleActionTaken(approval) {
    setProcessing(p => ({ ...p, [approval.id]: 'action_taken' }));
    try {
      await api.patchApproval(approval.id, 'action_taken');
      setProcessing(p => ({ ...p, [approval.id]: 'done' }));
      setTimeout(() => {
        setApprovals(prev => prev.filter(a => a.id !== approval.id));
        setProcessing(p => { const n = { ...p }; delete n[approval.id]; return n; });
      }, 1500);
    } catch (err) {
      console.error('Action taken failed:', err.message);
      setProcessing(p => ({ ...p, [approval.id]: null }));
    }
  }

  async function handleIgnore(approval) {
    setProcessing(p => ({ ...p, [approval.id]: 'ignoring' }));
    try {
      await api.patchApproval(approval.id, 'ignored');
      setApprovals(prev => prev.filter(a => a.id !== approval.id));
      setProcessing(p => { const n = { ...p }; delete n[approval.id]; return n; });
    } catch (err) {
      console.error('Ignore failed:', err.message);
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
        <p className="text-gray-500 font-mono uppercase tracking-widest">No pending predictions to review.</p>
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
        <h1 className="text-3xl font-bold tracking-tighter">Pending Predictions</h1>
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
          const isWorking = state === 'action_taken' || state === 'ignoring';
          const conf      = approval.confidence ? (approval.confidence * 100).toFixed(0) : '—';
          const predData  = approval.prediction_data || {};
          const rootCause = predData.root_cause || 'unknown';

          return (
            <motion.div key={approval.id} layout
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, filter: 'blur(10px)' }}
              className="mb-6 metal-container-static w-full" style={{ '--m-radius': '1.5rem', '--m-border': '1px' }}>
              <div className={`metal-surface p-8 transition-colors ${isDone ? 'bg-green-500/5' : ''}`}>

                {/* Success state */}
                {isDone ? (
                  <div className="flex flex-col items-center py-8 gap-4">
                    <CheckCircle className="text-green-500 w-12 h-12 animate-pulse drop-shadow-[0_0_15px_rgba(34,197,94,0.5)]" />
                    <h2 className="text-2xl font-bold text-green-400 tracking-tighter">Acknowledged</h2>
                    <p className="text-gray-400 mt-2 font-mono text-sm">Prediction for {approval.url || approval.service_id} marked as actioned</p>
                  </div>
                ) : (
                  <>
                    {/* Header */}
                    <div className="mb-6">
                      <span className="bg-amber-500/10 border border-amber-500/20 text-amber-500 text-xs px-3 py-1.5 rounded-full uppercase tracking-widest font-bold">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse mr-2" />
                        Review Required • {new Date(approval.created_at).toLocaleTimeString()}
                      </span>
                      <h2 className="text-2xl font-bold mt-6 tracking-tighter">
                        {rootCause.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                      </h2>
                      <p className="text-sm text-gray-400 font-mono mt-2 bg-white/5 inline-block px-3 py-1 rounded">
                        URL: <span className="text-white">{approval.url || approval.service_id}</span>
                        {' '}| Confidence: <span className="text-amber-500">{conf}%</span>
                        {' '}| Severity: <span className={approval.severity === 'critical' ? 'text-red-400' : 'text-amber-400'}>
                          {approval.severity}
                        </span>
                      </p>
                    </div>

                    {/* Root cause detail */}
                    {predData.message && (
                      <div className="mb-8 metal-container-static" style={{ '--m-radius': '0.75rem', '--m-border': '1px' }}>
                        <div className="metal-surface p-6">
                          <h3 className="text-xs text-gray-500 uppercase tracking-widest mb-3 font-mono">Analysis</h3>
                          <p className="text-gray-300 italic border-l-2 border-indigo/50 pl-4 bg-gradient-to-r from-indigo/5 to-transparent py-2">
                            "{predData.message}"
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Action bar — "Action Taken" (green) and "Ignore" (grey) */}
                    <div className="flex items-center gap-4 border-t border-white/10 pt-6">
                      <button
                        onClick={() => handleIgnore(approval)}
                        disabled={isWorking}
                        className="flex items-center gap-2 px-6 py-3 rounded-full border border-white/10 bg-white/5 text-gray-300 font-bold text-sm hover:bg-white/10 hover:text-white transition-all disabled:opacity-50"
                      >
                        <X size={16} />
                        {state === 'ignoring' ? 'Ignoring...' : 'Ignore'}
                      </button>

                      <button
                        onClick={() => handleActionTaken(approval)}
                        disabled={isWorking}
                        className="flex items-center gap-2 px-6 py-3 rounded-full bg-green-500/20 border border-green-500/30 text-green-400 font-bold text-sm hover:bg-green-500/30 hover:text-green-300 transition-all disabled:opacity-50 ml-auto"
                      >
                        <Check size={16} />
                        {state === 'action_taken' ? 'Processing...' : 'Action Taken'}
                      </button>
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