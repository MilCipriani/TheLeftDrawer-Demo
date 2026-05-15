import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import svgr from 'vite-plugin-svgr'


// https://vite.dev/config/
export default defineConfig({
  plugins: [svgr(), react(), tailwindcss()],
  server: {
    //where to listen and who can connect to vite
    host: '0.0.0.0',
    allowedHosts: ['all'],

    //where vite forwards requests
    proxy: {
      '/api': {
        target: 'http://localhost:80',  
        changeOrigin: true,
      }
    }
  }
  
})
