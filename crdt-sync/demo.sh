#!/bin/bash

# CRDT 文件同步演示脚本

echo "=== CRDT 文件同步演示 ==="
echo ""

# 创建测试目录
TEST_DIR="./test-sync"
LOCAL_DIR="$TEST_DIR/local"
REMOTE_DIR="$TEST_DIR/remote"

echo "1. 创建测试目录..."
rm -rf "$TEST_DIR"
mkdir -p "$LOCAL_DIR"
mkdir -p "$REMOTE_DIR"

# 创建测试文件
echo "2. 创建测试文件..."
echo "// Test file
function hello() {
    console.log('Hello World');
}" > "$LOCAL_DIR/test.ts"

echo "// Test file
function hello() {
    console.log('Hello World');
}" > "$REMOTE_DIR/test.ts"

echo ""
echo "=== 使用说明 ==="
echo ""
echo "终端 1 - 启动服务器:"
echo "  bun run server.ts"
echo ""
echo "终端 2 - 启动本地客户端:"
echo "  bun run client.ts --dir=$LOCAL_DIR"
echo ""
echo "终端 3 - 启动远端客户端:"
echo "  bun run client.ts --dir=$REMOTE_DIR"
echo ""
echo "然后尝试："
echo "  1. 在 $LOCAL_DIR/test.ts 中编辑"
echo "  2. 在 $REMOTE_DIR/test.ts 中编辑"
echo "  3. 观察两端自动同步"
echo ""
