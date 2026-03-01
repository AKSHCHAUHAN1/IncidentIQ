export default function MagicButton({ children, onClick, className = "" }) {
  return (
    <button 
      onClick={onClick} 
      className={`metal-container group ${className}`}
      style={{ '--m-radius': '9999px', '--m-border': '1px' }}
    >
      <div className="metal-surface px-6 py-3 flex items-center justify-center transition-colors group-hover:bg-[#151515]">
        {children}
      </div>
    </button>
  );
}