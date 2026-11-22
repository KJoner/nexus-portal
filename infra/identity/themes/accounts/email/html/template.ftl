<#-- 账号中心的邮件外壳：标题、正文、一段说明（与谁共用、与仓库密码无关）。正文仍是 Keycloak 的模板。 -->
<#macro emailLayout>
<html lang="${locale.language}" dir="${(ltr)?then('ltr','rtl')}">
<body style="margin:0;padding:0;background:#f7f7f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f5;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e3df;border-radius:12px;">
        <tr><td style="padding:24px 28px 8px 28px;font-family:'PingFang SC','Microsoft YaHei','Noto Sans SC',Arial,sans-serif;font-size:15px;font-weight:600;color:#232428;">${msg("acEmailBrand")}</td></tr>
        <tr><td style="padding:8px 28px 8px 28px;font-family:'PingFang SC','Microsoft YaHei','Noto Sans SC',Arial,sans-serif;font-size:15px;line-height:1.7;color:#232428;">
          <#nested>
        </td></tr>
        <tr><td style="padding:16px 28px 24px 28px;border-top:1px solid #efefec;font-family:'PingFang SC','Microsoft YaHei','Noto Sans SC',Arial,sans-serif;font-size:12.5px;line-height:1.7;color:#62646d;">${msg("acEmailFooter")}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
</#macro>
