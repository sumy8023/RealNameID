import crypto from "node:crypto";
import mysql from "mysql2/promise";

// 开发/自测用的两个库，本项目运行期只连这两个，不要指向任何真实库：
//   realnameauth_bfftest  业务主库，空库即可，后端启动时自己建表和迁移
//   xueji_bfftest         学籍库角色：账号表、管理员表、登录计数表、节点登记表
// 本脚本只创建缺失的对象并补齐开发种子数据，不会 DROP 任何库或表。
const MYSQL = { host: "127.0.0.1", port: 3306, user: "root", password: "root" };
const BUSINESS_DB = "realnameauth_bfftest";
const STUDENT_DB = "xueji_bfftest";

// 本脚本会建库建表并 REPLACE INTO 账号口令，一旦 host 或库名被改成现网值，就会直接覆盖真实学生和教师的口令。
// 因此这里不设开关、硬拦两道：只准连本机 MySQL，只准写带 _bfftest 后缀的开发库。
if (!/^(127\.0\.0\.1|localhost|::1)$/.test(String(MYSQL.host))) {
  throw new Error(`init-dev-dbs.mjs 只允许连本机 MySQL，当前 host=${MYSQL.host}`);
}
for (const db of [BUSINESS_DB, STUDENT_DB]) {
  if (!/_bfftest$/.test(db)) {
    throw new Error(`init-dev-dbs.mjs 只允许写带 _bfftest 后缀的开发库，当前目标库=${db}`);
  }
}

const md5 = (value) => crypto.createHash("md5").update(String(value)).digest("hex");

// 开发口令，只在这两个测试库里生效。
const DEMO = {
  admin: { name: "demo-admin", password: "DemoAdminPass2026", realName: "测试管理员", post: "机房管理员" },
  student: { num: "STUDENT-DEMO-001", password: "demo-student-password", name: "演示学生" },
  teacher: { num: "TEACHER-DEMO-ID", code: "TEACHER-DEMO", tel: "", password: "demo-teacher-password", name: "演示教师" },
};

const conn = await mysql.createConnection(MYSQL);

for (const db of [BUSINESS_DB, STUDENT_DB]) {
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${db}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
}
await conn.query(`USE \`${STUDENT_DB}\``);

await conn.query(`CREATE TABLE IF NOT EXISTS tp_student (
  stu_num VARCHAR(64) NOT NULL PRIMARY KEY COMMENT '学号，同时是登录账号',
  stu_pass CHAR(32) NOT NULL COMMENT '32位小写MD5口令',
  stu_name VARCHAR(50) NOT NULL COMMENT '姓名',
  pingbi TINYINT NOT NULL DEFAULT 0 COMMENT '1禁止登录，0允许'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='学生账号表（开发副本）'`);

await conn.query(`CREATE TABLE IF NOT EXISTS tp_teacher (
  teacher_num VARCHAR(64) NOT NULL PRIMARY KEY COMMENT '身份证号，教师登录后的唯一身份',
  teacher_code VARCHAR(20) NULL COMMENT '工号，可作登录账号',
  tel VARCHAR(20) NULL COMMENT '手机号，可作登录账号',
  teacher_pass CHAR(32) NOT NULL COMMENT '32位小写MD5口令',
  teacher_name VARCHAR(50) NOT NULL COMMENT '姓名',
  pingbi TINYINT NOT NULL DEFAULT 0 COMMENT '1禁止登录，0允许'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='教师账号表（开发副本）'`);

await conn.query(`CREATE TABLE IF NOT EXISTS tp_admin (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_name VARCHAR(50) NOT NULL COMMENT '登录名',
  admin_pass CHAR(32) NOT NULL COMMENT '32位小写MD5口令',
  admin_xm VARCHAR(50) NULL COMMENT '姓名',
  post VARCHAR(50) NULL COMMENT '职务',
  state TINYINT NOT NULL DEFAULT 1 COMMENT '0禁用，1启用',
  login_last INT NULL COMMENT '最后登录时间戳',
  login_ip VARCHAR(50) NULL COMMENT '最后登录IP',
  UNIQUE KEY uk_admin_name (admin_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='管理员表（开发副本，BFF 复用同一套账号）'`);

await conn.query(`CREATE TABLE IF NOT EXISTS tp_login_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL COMMENT '登录名',
  attempt_time INT NOT NULL COMMENT '最近一次失败时间戳',
  ip_address VARCHAR(64) NULL COMMENT '来源IP',
  login_attempts INT NOT NULL DEFAULT 0 COMMENT '累计失败次数',
  KEY idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='登录失败计数表，与 管理后台 登录同结构'`);

// 节点登记表由 BFF 启动时自建，这里提前建好方便直接插开发节点。
await conn.query(`CREATE TABLE IF NOT EXISTS tp_smsj_nodes (
  node_code VARCHAR(64) NOT NULL PRIMARY KEY COMMENT '后端节点稳定编号',
  region_name VARCHAR(100) NOT NULL COMMENT '区域名称',
  node_address VARCHAR(500) NOT NULL COMMENT '后端服务地址',
  online_status TINYINT(1) NOT NULL DEFAULT 0 COMMENT '最近一次检测状态',
  last_check_at DATETIME NULL COMMENT '最近一次检测时间',
  last_error VARCHAR(500) NULL COMMENT '最近一次失败原因',
  register_key VARCHAR(128) NOT NULL COMMENT '签名用注册密钥',
  is_default TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否默认节点',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='后端节点登记表（开发副本）'`);

// 种子数据用 REPLACE INTO，重复执行只会把口令和姓名刷回初始值，不会累加。
await conn.query(
  `REPLACE INTO tp_student (stu_num, stu_pass, stu_name, pingbi) VALUES (?, ?, ?, 0)`,
  [DEMO.student.num, md5(DEMO.student.password), DEMO.student.name],
);
await conn.query(
  `REPLACE INTO tp_teacher (teacher_num, teacher_code, tel, teacher_pass, teacher_name, pingbi) VALUES (?, ?, ?, ?, ?, 0)`,
  [DEMO.teacher.num, DEMO.teacher.code, DEMO.teacher.tel, md5(DEMO.teacher.password), DEMO.teacher.name],
);
await conn.query(
  `REPLACE INTO tp_admin (admin_name, admin_pass, admin_xm, post, state) VALUES (?, ?, ?, ?, 1)`,
  [DEMO.admin.name, md5(DEMO.admin.password), DEMO.admin.realName, DEMO.admin.post],
);
// 本机单节点后端：与 Server/src/config.js 的 nodeCode/nodeRegistrationKey 保持一致。
await conn.query(
  `INSERT INTO tp_smsj_nodes (node_code, region_name, node_address, register_key, is_default)
   VALUES ('node01', '本机开发节点', 'http://127.0.0.1:14848', 'LocalDemoNodeKey2026', 1)
   ON DUPLICATE KEY UPDATE region_name = VALUES(region_name), node_address = VALUES(node_address)`,
);
await conn.query(`UPDATE tp_smsj_nodes SET is_default = CASE WHEN node_code = 'node01' THEN 1 ELSE is_default END`);

const [businessTables] = await conn.query(
  `SELECT COUNT(*) c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
  [BUSINESS_DB],
);
const [studentTables] = await conn.query(
  `SELECT COUNT(*) c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
  [STUDENT_DB],
);
await conn.end();

console.log(`业务库 ${BUSINESS_DB}：${businessTables[0].c} 张表（0 张是正常的，后端启动时会自动建表）`);
console.log(`学籍库 ${STUDENT_DB}：${studentTables[0].c} 张表`);
console.log("开发账号：");
console.log(`  管理后台   ${DEMO.admin.name} / ${DEMO.admin.password}`);
console.log(`  学生上机   ${DEMO.student.num} / ${DEMO.student.password}`);
console.log(`  教师上机   ${DEMO.teacher.code} / ${DEMO.teacher.password}`);
console.log("下一步：cd Server && npm start（建业务表），再 cd vue/server && npm start");
