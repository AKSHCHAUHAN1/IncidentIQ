import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Link, useLocation } from 'react-router-dom';
import { Activity, GitBranch, History, ShieldAlert, BarChart2, Globe } from 'lucide-react';
import { socket } from '../socket';
import { api } from '../lib/api';

export default function Navbar() {
  const [scrolled, setScrolled]               = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const location = useLocation();

  async function refreshCount() {
    try { const d = await api.approvalCount(); setPendingApprovals(d.count || 0); }
    catch {}
  }

  useEffect(() => {
    refreshCount();
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);

    // new_prediction may add to the approval queue
    socket.on('new_prediction', () => setPendingApprovals(p => p + 1));
    // new_alert doesn't affect approvals badge but refresh to be safe
    socket.on('new_alert', refreshCount);

    const t = setInterval(refreshCount, 30_000);
    return () => {
      window.removeEventListener('scroll', onScroll);
      socket.off('new_prediction');
      socket.off('new_alert');
      clearInterval(t);
    };
  }, []);

  const NavItem = ({ icon, label, path, badge, isCritical }) => {
    const active = location.pathname === path;
    return (
      <Link to={path} className={`flex items-center gap-2 transition-all hover:text-white text-sm font-semibold
        ${active ? 'text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]' : 'text-gray-400'}
        ${isCritical && badge > 0 ? 'text-red-400' : ''}`}>
        {icon} <span>{label}</span>
        {badge > 0 && (
          <span className="bg-red-500/20 border border-red-500/30 text-red-500 text-xs px-2 py-0.5 rounded-full font-bold">
            {badge}
          </span>
        )}
      </Link>
    );
  };

  return (
    <>
      <div className={`fixed top-0 inset-x-0 h-32 z-40 transition-opacity duration-700 pointer-events-none ${scrolled ? 'opacity-100' : 'opacity-0'}`}
        style={{ backdropFilter: 'blur(20px)', maskImage: 'linear-gradient(to bottom, black 20%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 20%, transparent 100%)' }} />

      <div className="fixed top-6 w-full flex justify-center z-50 pointer-events-none">
        <motion.nav initial={{ y: -100 }} animate={{ y: 0 }}
          style={{ '--m-radius': '9999px', '--m-border': '1px' }}
          className={`pointer-events-auto transition-all duration-700 metal-container ${scrolled ? 'shadow-[0_20px_50px_rgba(0,0,0,0.9)]' : 'shadow-lg'}`}>
          <div className="metal-surface px-8 py-4 flex items-center gap-6">
            <div className="relative group flex items-center justify-center">
              <div className="absolute -inset-2 bg-indigo-500/30 blur-[12px] rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-0 pointer-events-none" />
              <Link to="/" className="incident-logo-gradient text-2xl tracking-widest hover:scale-105 transition-transform duration-300 z-10"
                style={{ fontFamily: "'Chillax', system-ui, sans-serif", fontWeight: 700 }}>
                IncidentIQ
              </Link>
            </div>
            <div className="w-[1px] h-8 bg-white/20 mx-1" />
            <div className="flex items-center gap-5">
              <NavItem icon={<Activity size={16}/>}    label="Dashboard"   path="/" />
              <NavItem icon={<Globe size={16}/>}       label="Monitor"     path="/monitor" />
              <NavItem icon={<GitBranch size={16}/>}   label="Predictions" path="/predictions" />
              <NavItem icon={<History size={16}/>}     label="Incidents"   path="/incidents" />
              <NavItem icon={<ShieldAlert size={16}/>} label="Alerts"      path="/alerts" badge={pendingApprovals} isCritical />
              <NavItem icon={<BarChart2 size={16}/>}   label="Analytics"   path="/analytics" />
            </div>
          </div>
        </motion.nav>
      </div>
    </>
  );
}