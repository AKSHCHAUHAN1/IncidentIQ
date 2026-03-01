/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#050505", // Deep cinematic black
        surface: "rgba(20, 20, 20, 0.4)",
        border: "rgba(255, 255, 255, 0.08)",
        indigo: "#6366f1", // Accent color [cite: 1226]
        critical: "#ef4444", // Red alerts [cite: 1226]
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'], // Professional SaaS font [cite: 1228]
      },
      letterSpacing: {
        tighter: '-0.02em', // Awwwards editorial feel
      },
      backgroundImage: {
        'glass-gradient': 'linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.01) 100%)',
        'specular': 'radial-gradient(circle at 50% 0%, rgba(255,255,255,0.15) 0%, transparent 60%)',
      },
      animation: {
        'beam': 'beam 3s infinite linear',
      },
      keyframes: {
        beam: {
          '0%': { transform: 'translateX(-100%)', opacity: 0 },
          '50%': { opacity: 1 },
          '100%': { transform: 'translateX(100%)', opacity: 0 },
        }
      }
    },
  },
  plugins: [],
}