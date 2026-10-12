set -e
cd "$1"
mkdir -p /tmp/mp/in /tmp/mp/stage/data
echo A > /tmp/mp/in/a.txt
echo B > /tmp/mp/stage/data/memphis.db
echo "### tar -V:"; tar --version 2>&1 | head -2
echo "### probe 1: --transform"; tar --transform='s|^data/memphis.db|./data/memphis.db|' -czf /tmp/mp/p1.tar.gz -C /tmp/mp/in . -C /tmp/mp/stage data/memphis.db 2>&1 && echo "exit=0" || echo "exit=$?"
echo "### probe 2: -s EXPR"; tar -s 's|^data/memphis.db|./data/memphis.db|' -czf /tmp/mp/p2.tar.gz -C /tmp/mp/in . -C /tmp/mp/stage data/memphis.db 2>&1 && echo "exit=0" || echo "exit=$?"
echo "### probe 3: -s=EXPR"; tar -s='s|^data/memphis.db|./data/memphis.db|' -czf /tmp/mp/p3.tar.gz -C /tmp/mp/in . -C /tmp/mp/stage data/memphis.db 2>&1 && echo "exit=0" || echo "exit=$?"
echo "### probe 4: --warning"; tar --warning=file-changed --version 2>&1 | head -1 || true
