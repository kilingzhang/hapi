#!/bin/bash

# 远端 CRDT 同步设置脚本

set -e

echo "=== CRDT 文件同步 - 远端设置 ==="
echo ""

# 检查参数
if [ -z "$1" ]; then
    echo "用法: $0 <项目目录> [服务器地址]"
    echo "示例: $0 /path/to/project ws://your-server:1234"
    exit 1
fi

PROJECT_DIR="$1"
WS_SERVER="${2:-ws://localhost:1234}"

echo "项目目录: $PROJECT_DIR"
echo "服务器地址: $WS_SERVER"
echo ""

# 检查目录是否存在
if [ ! -d "$PROJECT_DIR" ]; then
    echo "错误: 目录不存在: $PROJECT_DIR"
    exit 1
fi

# 检查 bun 是否安装
if ! command -v bun &> /dev/null; then
    echo "错误: 需要安装 Bun"
    echo "安装: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# 检查依赖是否安装
if [ ! -d "node_modules" ]; then
    echo "安装依赖..."
    bun install
fi

# 创建 systemd 服务文件（Linux）
if command -v systemctl &> /dev/null; then
    echo "创建 systemd 服务..."
    
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    SERVICE_FILE="/etc/systemd/system/crdt-sync-$(basename $PROJECT_DIR).service"
    
    sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=CRDT File Sync for $(basename $PROJECT_DIR)
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=$(which bun) run client.ts --dir=$PROJECT_DIR --server=$WS_SERVER
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

    echo "服务文件已创建: $SERVICE_FILE"
    echo ""
    echo "启动服务:"
    echo "  sudo systemctl start crdt-sync-$(basename $PROJECT_DIR)"
    echo ""
    echo "开机自启:"
    echo "  sudo systemctl enable crdt-sync-$(basename $PROJECT_DIR)"
    echo ""
    echo "查看日志:"
    echo "  sudo journalctl -u crdt-sync-$(basename $PROJECT_DIR) -f"
else
    echo "未检测到 systemd，使用后台进程方式..."
    
    # 创建启动脚本
    START_SCRIPT="$PROJECT_DIR/.crdt-sync-start.sh"
    cat > "$START_SCRIPT" <<EOF
#!/bin/bash
cd "$(dirname "${BASH_SOURCE[0]}")/.."
bun run client.ts --dir="$PROJECT_DIR" --server="$WS_SERVER"
EOF

    chmod +x "$START_SCRIPT"
    
    echo "启动脚本已创建: $START_SCRIPT"
    echo ""
    echo "手动启动:"
    echo "  $START_SCRIPT &"
    echo ""
    echo "或使用 nohup:"
    echo "  nohup $START_SCRIPT > $PROJECT_DIR/.crdt-sync.log 2>&1 &"
fi

echo ""
echo "=== 设置完成 ==="
echo ""
echo "现在两端都会自动同步文件变化！"
