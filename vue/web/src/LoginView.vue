<script setup>
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Lock, User } from "@element-plus/icons-vue";
import { api } from "./api/client.js";

const router = useRouter();
const route = useRoute();
const form = reactive({ admin_name: "", admin_pass: "" });
const error = ref("");
const submitting = ref(false);

async function submit() {
  if (!form.admin_name || !form.admin_pass) {
    error.value = "请输入用户名和密码";
    return;
  }
  submitting.value = true;
  error.value = "";
  try {
    const ret = await api.post("login", { ...form }, { silent: true });
    api.user = ret.user;
    api.checked = true;
    router.replace(route.query.redirect || "/overview");
  } catch (err) {
    error.value = err.message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login">
    <section class="login-visual">
      <div class="login-visual-inner">
        <span class="login-mark">▚</span>
        <h1>实名上机管理后台</h1>
        <p>节点接入 · 教室与设备 · 上机会话 · 运行日志</p>
        <ul class="login-points">
          <li>教室、设备、会话等业务数据始终存放在各节点自己的库里</li>
          <li>后台按注册密钥签名转发，浏览器不接触任何节点凭据</li>
          <li>使用校区后台的管理员账号登录</li>
        </ul>
      </div>
    </section>

    <section class="login-pane">
      <form class="login-card" @submit.prevent="submit">
        <h2>登录</h2>
        <p class="login-sub">请使用校区后台的管理员账号</p>

        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="login-error" />

        <label class="login-field">
          <span>用户名</span>
          <el-input v-model="form.admin_name" size="large" autocomplete="username" placeholder="管理员账号">
            <template #prefix><el-icon><User /></el-icon></template>
          </el-input>
        </label>
        <label class="login-field">
          <span>密码</span>
          <el-input v-model="form.admin_pass" size="large" type="password" autocomplete="current-password" placeholder="登录密码" show-password>
            <template #prefix><el-icon><Lock /></el-icon></template>
          </el-input>
        </label>

        <el-button type="primary" size="large" native-type="submit" :loading="submitting" class="login-submit">登录</el-button>
      </form>
    </section>
  </div>
</template>

<style scoped>
.login { display: grid; grid-template-columns: minmax(0, 1fr) 460px; min-height: 100vh; background: #fff; }

.login-visual {
  position: relative; display: flex; align-items: center; justify-content: center; padding: 48px 56px; overflow: hidden;
  background: linear-gradient(150deg, #0f1e2e 0%, #14293f 55%, #0d2138 100%); color: #e8eef6;
}
.login-visual::after {
  content: ""; position: absolute; inset: -40% -20% auto auto; width: 560px; height: 560px; border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, rgba(77, 132, 232, .32), transparent 62%);
}
.login-visual-inner { position: relative; max-width: 460px; }
.login-mark { display: grid; place-items: center; width: 46px; height: 46px; margin-bottom: 22px; border-radius: 13px; background: linear-gradient(140deg, #4d84e8, #0e55bd); font-size: 22px; }
.login-visual h1 { margin: 0 0 10px; font-size: 30px; font-weight: 650; letter-spacing: -.01em; }
.login-visual p { margin: 0 0 30px; color: #8fa6bf; font-size: 14px; }
.login-points { margin: 0; padding: 0; list-style: none; display: grid; gap: 13px; }
.login-points li { position: relative; padding-left: 20px; color: #b7c7d8; font-size: 13.5px; line-height: 21px; }
.login-points li::before { content: ""; position: absolute; left: 0; top: 7px; width: 8px; height: 8px; border-radius: 50%; background: var(--brand-400); }

.login-pane { display: grid; place-items: center; padding: 40px 36px; background: #f7f9fc; }
.login-card { width: 100%; max-width: 352px; padding: 34px 32px; border: 1px solid var(--line); border-radius: 16px; background: #fff; box-shadow: 0 1px 2px rgba(15, 27, 43, .04), 0 18px 40px -24px rgba(15, 27, 43, .28); }
.login-card h2 { margin: 0 0 4px; font-size: 21px; font-weight: 650; }
.login-sub { margin: 0 0 22px; color: var(--muted); font-size: 13px; }
.login-error { margin-bottom: 16px; }
.login-field { display: block; margin-bottom: 16px; }
.login-field > span { display: block; margin-bottom: 6px; color: var(--ink-2); font-size: 13px; font-weight: 500; }
.login-submit { width: 100%; margin-top: 6px; }

@media (max-width: 900px) {
  .login { grid-template-columns: 1fr; }
  .login-visual { display: none; }
}
</style>
