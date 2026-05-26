import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0A0D12",
        panel: "#11151C",
        panel2: "#151A22",
        border: "#1E2530",
        muted: "#6B7383",
        brand: "#26E5A1",
        warm: "#F4B740",
        danger: "#FF5A5F",
      },
      fontFamily: {
        sans: ['Inter', 'SF Pro Display', 'DM Sans', 'system-ui', 'sans-serif'],
      },
      fontVariantNumeric: {
        tabular: 'tabular-nums',
      },
    },
  },
  plugins: [],
};
export default config;
