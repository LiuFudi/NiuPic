/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 主题色（强调色）—— 整族 blue-* 重映射到 CSS 变量。
        // 界面里 150 多处用的是 bg-blue-500 / text-blue-600 这类类名，
        // 把它们统一指到变量上，换主题色只要改 11 个变量，不用动一处 JSX。
        // 变量写成 "R G B" 三元组，<alpha-value> 才支持 bg-blue-500/40 这种透明度写法。
        // 默认值在 src/index.css 的 :root 里（等值于 Tailwind 官方 blue）。
        blue: {
          50: 'rgb(var(--accent-50) / <alpha-value>)',
          100: 'rgb(var(--accent-100) / <alpha-value>)',
          200: 'rgb(var(--accent-200) / <alpha-value>)',
          300: 'rgb(var(--accent-300) / <alpha-value>)',
          400: 'rgb(var(--accent-400) / <alpha-value>)',
          500: 'rgb(var(--accent-500) / <alpha-value>)',
          600: 'rgb(var(--accent-600) / <alpha-value>)',
          700: 'rgb(var(--accent-700) / <alpha-value>)',
          800: 'rgb(var(--accent-800) / <alpha-value>)',
          900: 'rgb(var(--accent-900) / <alpha-value>)',
          950: 'rgb(var(--accent-950) / <alpha-value>)',
        },
        // 优化后的灰色调 - 微暖色调，护眼舒适
        // 基于色彩心理学：避免纯黑，降低对比度，减少眼疲劳
        gray: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e8e8e8',      // 稍微调亮，柔和边框
          300: '#d4d4d4',
          400: '#a8a8a8',      // 微调亮度
          500: '#7a7a7a',      // 中间色调亮
          600: '#5a5a5a',      // 调亮，减少对比
          700: '#454545',      // 调亮，更舒适
          800: '#2c2c2c',      // 从 #262626 调亮（侧边栏）
          900: '#1e1e1e',      // 从 #171717 调亮（主背景，避免纯黑）
          950: '#121212',      // 保留深色选项
        },
      },
    },
  },
  plugins: [],
}
