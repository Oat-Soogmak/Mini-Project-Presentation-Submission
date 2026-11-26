# IT Helpdesk – อิมเมจสำหรับใช้งานจริง (ไม่มี dependency ภายนอก ไม่ต้อง npm install)
# node:sqlite ต้องใช้ Node 22.13 ขึ้นไป
FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# โฟลเดอร์ข้อมูลและไฟล์สำรองเป็นของผู้ใช้ node (volume ที่สร้างใหม่จะรับสิทธิ์นี้ไปด้วย)
RUN mkdir -p /data /backups && chown -R node:node /data /backups
USER node

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
