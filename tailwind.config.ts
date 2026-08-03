import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#0B0E11",
        card: "#181A20",
        "row-odd": "#1E222B",
        border: "#2B3139",
        accent: "#00B0BD",
        negative: "#F6465D",
        neutral: "#848E9C",
        "text-main": "#EAECEF",
        highlight: "#FCD535",
      },
      fontFamily: {
        display: ["Chakra Petch", "Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
