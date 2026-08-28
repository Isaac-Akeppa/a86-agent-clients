module.exports = {
  apps: [
    {
      name: 'mps-agent-clients',
      script: 'node_modules/.bin/tsx',
      args: 'src/main.ts',
      cwd: __dirname,
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
}
