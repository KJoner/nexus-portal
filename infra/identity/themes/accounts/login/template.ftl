<#--
  账号中心（LiteSync 与 Nexus 共用）的页面外壳 · UI v2（v12.0.3 V1）。

  基于 Keycloak 26.8.1 keycloak.v2/login/template.ftl（sha256 6221a3176c73a3fd67abc97076deb9cef112378ce157735a78bd865800315b37）。
  只改 <body> 的版式：左侧品牌与装饰图、右侧表单；<head> 原样保留，另加一行 js/theme-toggle.js。
  各页面（login.ftl、register.ftl……）仍用 Keycloak 自带的模板和动态字段，表单 action、隐藏字段、
  错误、验证、过期链接的处理都不变。升级 Keycloak 时先对照新版的同名文件（见 infra/identity/README.md）。
-->
<#import "field.ftl" as field>
<#import "footer.ftl" as loginFooter>
<#import "theme-resources.ftl" as themeResourceTags>
<#macro username>
  <#assign label>
    <#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if>
  </#assign>
  <@field.group name="username" label=label>
    <div class="${properties.kcInputGroup}">
      <div class="${properties.kcInputGroupItemClass} ${properties.kcFill}">
        <span class="${properties.kcInputClass} ${properties.kcFormReadOnlyClass}">
          <input id="kc-attempted-username" value="${auth.attemptedUsername}" readonly>
        </span>
      </div>
      <div class="${properties.kcInputGroupItemClass}">
        <button id="reset-login" class="${properties.kcFormPasswordVisibilityButtonClass} kc-login-tooltip" type="button"
              aria-label="${msg('restartLoginTooltip')}" onclick="location.href='${url.loginRestartFlowUrl}'">
            <i class="fa-sync-alt fas" aria-hidden="true"></i>
            <span class="kc-tooltip-text">${msg("restartLoginTooltip")}</span>
        </button>
      </div>
    </div>
  </@field.group>
</#macro>

<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html class="${properties.kcHtmlClass!}" lang="${lang}"<#if realm.internationalizationEnabled> dir="${(locale.rtl)?then('rtl','ltr')}"</#if>>

<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="color-scheme" content="light${darkMode?then(' dark', '')}">
    <meta name="viewport" content="width=device-width, initial-scale=1">

    <#if properties.meta?has_content>
        <#list properties.meta?split(' ') as meta>
            <meta name="${meta?split('==')[0]}" content="${meta?split('==')[1]}"/>
        </#list>
    </#if>
    <title>${title!}</title>
    <#if themeResources?? && themeResources.favicons?has_content>
        <@themeResourceTags.renderFavicons themeResources.favicons url.resourcesPath />
    <#else>
        <link rel="icon" href="${url.resourcesPath}/img/favicon.ico" />
    </#if>
    <#if themeResources?? && themeResources.stylesCommon?has_content>
        <@themeResourceTags.renderStyles themeResources.stylesCommon url.resourcesCommonPath />
    <#elseif properties.stylesCommon?has_content>
        <#list properties.stylesCommon?split(' ') as style>
            <link href="${url.resourcesCommonPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if themeResources?? && themeResources.styles?has_content>
        <@themeResourceTags.renderStyles themeResources.styles url.resourcesPath />
    <#elseif properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <script type="importmap">
        {
            "imports": {
                "rfc4648": "${url.resourcesCommonPath}/vendor/rfc4648/rfc4648.js"
            }
        }
    </script>
    <#if darkMode>
      <script type="module" async blocking="render">
          <#outputformat "JavaScript">
          const DARK_MODE_CLASS = ${properties.kcDarkModeClass?c};
          const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

          updateDarkMode(mediaQuery.matches);
          mediaQuery.addEventListener("change", (event) => updateDarkMode(event.matches));

          function updateDarkMode(isEnabled) {
            const { classList } = document.documentElement;

            if (isEnabled) {
              classList.add(DARK_MODE_CLASS);
            } else {
              classList.remove(DARK_MODE_CLASS);
            }
          }
          </#outputformat>
      </script>
      <#-- 账号中心：手动选择深浅色（存在本域名的 localStorage；没选过就跟随系统，与上面的自带脚本一致） -->
      <script type="module" src="${url.resourcesPath}/js/theme-toggle.js" blocking="render"></script>
    </#if>
    <#if themeResources?? && themeResources.scripts?has_content>
        <@themeResourceTags.renderScripts themeResources.scripts url.resourcesPath "text/javascript" />
    <#elseif properties.scripts?has_content>
        <#list properties.scripts?split(' ') as script>
            <script src="${url.resourcesPath}/${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <script type="module" src="${url.resourcesPath}/js/passwordVisibility.js"></script>
    <script type="module">
        <#outputformat "JavaScript">
        import { startSessionPolling } from ${(url.resourcesPath + "/js/authChecker.js")?c};

        startSessionPolling(
            ${url.ssoLoginInOtherTabsUrl?c}
        );
        </#outputformat>
    </script>
    <script type="module">
        document.addEventListener("click", (event) => {
            const link = event.target.closest("a[data-once-link]");

            if (!link) {
                return;
            }

            if (link.getAttribute("aria-disabled") === "true") {
                event.preventDefault();
                return;
            }

            const { disabledClass } = link.dataset;

            if (disabledClass) {
                link.classList.add(...disabledClass.trim().split(/\s+/));
            }

            link.setAttribute("role", "link");
            link.setAttribute("aria-disabled", "true");
        });
    </script>
    <#if authenticationSession??>
        <script type="module">
             <#outputformat "JavaScript">
            import { checkAuthSession } from ${(url.resourcesPath + "/js/authChecker.js")?c};

            checkAuthSession(
                ${authenticationSession.authSessionIdHash?c}
            );
            </#outputformat>
        </script>
    </#if>
    <script>
      // Workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1404468
      const isFirefox = true;
    </script>
</head>

<#--
  产品信息只取服务器可信的数据：产品名来自 client 指定的子主题（accounts-litesync / accounts-nexus）的文字，
  「返回」链接来自 client 配置的 baseUrl。请求参数不参与。没有子主题（例如账号控制台的登录）就不显示。
-->
<#assign acPage = pageId!"">
<#assign acProduct = msg("acProductName")>
<#assign acReturnUrl = (client.baseUrl)!"">
<#assign acLead = "">
<#if acPage == "login"><#assign acLead = msg("acLeadLogin")>
<#elseif acPage == "register"><#assign acLead = msg("acLeadRegister")>
<#-- 找回页：Keycloak 自己的说明（info 区）挪到标题下作导语，info 区由 CSS 隐藏，避免说两遍 -->
<#elseif acPage == "login-reset-password"><#assign acLead = realm.duplicateEmailsAllowed?then(msg("emailInstructionUsername"), msg("emailInstruction"))>
</#if>
<#assign acOrb = "">
<#switch acPage>
  <#case "login-reset-password"><#case "login-update-password"><#assign acOrb = "lock"><#break>
  <#case "login-verify-email"><#case "update-email"><#assign acOrb = "mail"><#break>
  <#case "info"><#case "login-page-expired"><#assign acOrb = "info"><#break>
  <#case "error"><#assign acOrb = "alert"><#break>
  <#case "logout-confirm"><#assign acOrb = "exit"><#break>
  <#default>
</#switch>
<body id="keycloak-bg" class="${properties.kcBodyClass!} ac-body" data-page-id="login-${pageId}">
<div class="ac-stage">
  <div class="ac-card">
    <aside class="ac-visual" aria-label="${msg("acVisualLabel")}">
      <div class="ac-brand-row">
        <span class="ac-brand"><svg class="ac-brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 21 12 12 21 3 12Z"/><path d="m12 7 5 5-5 5-5-5Z"/></svg>LiteSync</span>
        <span class="ac-brand-separator" aria-hidden="true"></span>
        <span class="ac-brand"><span class="ac-nexus-dot" aria-hidden="true"></span>Nexus</span>
      </div>
      <div class="ac-visual-copy">
        <p class="ac-visual-eyebrow" lang="en">${msg("acVisualEyebrow")}</p>
        <p class="ac-visual-title">${msg("acVisualTitle1")}<br>${msg("acVisualTitle2")}</p>
        <p class="ac-visual-text">${msg("acVisualText1")}<br>${msg("acVisualText2")}</p>
      </div>
      <p class="ac-visual-foot"><svg class="ac-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>${msg("acVisualFoot")}</p>
    </aside>

    <main class="ac-form-side">
      <div class="ac-utility-row">
        <#if realm.internationalizationEnabled  && locale.supported?size gt 1>
        <div class="ac-locale ${properties.kcLoginMainHeaderUtilities!}">
          <div class="${properties.kcInputClass!}">
            <select
              aria-label="${msg("languages")}"
              id="login-select-toggle"
              onchange="if (this.value) window.location.href=this.value"
            >
              <#list locale.supported?sort_by("label") as l>
                <option
                  value="${l.url}"
                  ${(l.languageTag == locale.currentLanguageTag)?then('selected','')}
                >
                  ${l.label}
                </option>
              </#list>
            </select>
            <span class="${properties.kcFormControlUtilClass}">
              <span class="${properties.kcFormControlToggleIcon!}">
                <svg
                  class="pf-v5-svg"
                  viewBox="0 0 320 512"
                  fill="currentColor"
                  aria-hidden="true"
                  role="img"
                  width="1em"
                  height="1em"
                >
                  <path
                    d="M31.3 192h257.3c17.8 0 26.7 21.5 14.1 34.1L174.1 354.8c-7.8 7.8-20.5 7.8-28.3 0L17.2 226.1C4.6 213.5 13.5 192 31.3 192z"
                  >
                  </path>
                </svg>
              </span>
            </span>
          </div>
        </div>
        </#if>
        <#if darkMode>
        <button type="button" class="ac-theme-toggle" id="ac-theme-toggle" hidden
                data-label-dark="${msg("acThemeToDark")}" data-label-light="${msg("acThemeToLight")}" aria-label="${msg("acThemeToDark")}">
          <svg class="ac-icon ac-icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/></svg>
          <svg class="ac-icon ac-icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>
        </button>
        </#if>
      </div>

      <div class="ac-form-wrap">
        <#if acOrb?has_content>
        <div class="ac-orb" aria-hidden="true">
          <#switch acOrb>
            <#case "lock"><svg class="ac-icon" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/></svg><#break>
            <#case "mail"><svg class="ac-icon" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></svg><#break>
            <#case "alert"><svg class="ac-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3.5v.5"/></svg><#break>
            <#case "exit"><svg class="ac-icon" viewBox="0 0 24 24"><path d="M10 4H5v16h5m4-12 4 4-4 4m-6-4h10"/></svg><#break>
            <#default><svg class="ac-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.5"/></svg>
          </#switch>
        </div>
        </#if>
        <p class="ac-eyebrow">${msg("acEyebrow")}</p>
        <h1 class="ac-title" id="kc-page-title"><#nested "header"></h1>
        <#if acLead?has_content><p class="ac-lead">${acLead}</p></#if>
        <#if acProduct?has_content>
        <p class="ac-return-chip"><span class="ac-chip-dot" aria-hidden="true"></span>${msg("acReturnChip", acProduct)}<svg class="ac-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg></p>
        </#if>

        <div class="ac-form-body">
        <#if !(auth?has_content && auth.showUsername() && !auth.showResetCredentials())>
            <#if displayRequiredFields>
                <div class="${properties.kcContentWrapperClass!}">
                    <div class="${properties.kcLabelWrapperClass!} subtitle">
                        <span class="${properties.kcInputHelperTextItemTextClass!}">
                          <span class="${properties.kcInputRequiredClass!}">*</span> ${msg("requiredFields")}
                        </span>
                    </div>
                </div>
            </#if>
        <#else>
            <#if displayRequiredFields>
                <div class="${properties.kcContentWrapperClass!}">
                    <div class="${properties.kcLabelWrapperClass!} subtitle">
                        <span class="${properties.kcInputHelperTextItemTextClass!}">
                          <span class="${properties.kcInputRequiredClass!}">*</span> ${msg("requiredFields")}
                        </span>
                    </div>
                    <div class="${properties.kcFormClass} ${properties.kcContentWrapperClass}">
                        <#nested "show-username">
                        <@username />
                    </div>
                </div>
            <#else>
                <div class="${properties.kcFormClass} ${properties.kcContentWrapperClass}">
                  <#nested "show-username">
                  <@username />
                </div>
            </#if>
        </#if>

        <#-- App-initiated actions should not see warning messages about the need to complete the action -->
        <#-- during login.                                                                               -->
        <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
            <div class="${properties.kcAlertClass!} pf-m-${(message.type = 'error')?then('danger', message.type)}">
                <div class="${properties.kcAlertIconClass!}">
                    <#if message.type = 'success'><span class="${properties.kcFeedbackSuccessIcon!}"></span></#if>
                    <#if message.type = 'warning'><span class="${properties.kcFeedbackWarningIcon!}"></span></#if>
                    <#if message.type = 'error'><span class="${properties.kcFeedbackErrorIcon!}"></span></#if>
                    <#if message.type = 'info'><span class="${properties.kcFeedbackInfoIcon!}"></span></#if>
                </div>
                <span class="${properties.kcAlertTitleClass!} kc-feedback-text">${message.summary}</span>
            </div>
        </#if>

        <#nested "form">

        <#if auth?has_content && auth.showTryAnotherWayLink()>
          <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post" novalidate="novalidate">
              <input type="hidden" name="tryAnotherWay" value="on"/>
              <a id="try-another-way" href="javascript:document.forms['kc-select-try-another-way-form'].requestSubmit()"
                  class="${properties.kcButtonSecondaryClass} ${properties.kcButtonBlockClass} ${properties.kcMarginTopClass}">
                    ${msg("doTryAnotherWay")}
              </a>
          </form>
        </#if>

        <#if switchOrganizationEnabled?? && switchOrganizationEnabled>
          <form id="kc-switch-organization-form" action="${url.loginAction}" method="post" novalidate="novalidate">
              <input type="hidden" name="switchOrganization" value="true"/>
              <a id="switch-organization" href="javascript:document.forms['kc-switch-organization-form'].requestSubmit()"
                  class="${properties.kcButtonSecondaryClass} ${properties.kcButtonBlockClass} ${properties.kcMarginTopClass}">
                    ${msg("doSwitchOrganization")}
              </a>
          </form>
        </#if>

          <div class="ac-after-form">
              <#nested "socialProviders">

              <#if displayInfo>
                  <div id="kc-info" class="ac-info ${properties.kcFormClass}">
                      <div id="kc-info-wrapper" class="ac-info-wrapper">
                          <#nested "info">
                      </div>
                  </div>
              </#if>
          </div>
        </div>

        <#-- 账号密码与仓库密码的分界：登录、注册、找回这三页各说一句（文字在 messages 里） -->
        <#if acPage == "login" || acPage == "register" || acPage == "login-reset-password">
        <div class="ac-privacy-note">
          <svg class="ac-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/></svg>
          <p>
            <#if acPage == "login">${msg("acPrivacyLogin1")}<br>${msg("acPrivacyLogin2")}
            <#elseif acPage == "register"><#-- 开启「验证邮箱」时 Keycloak 26.8 不在注册表单里收密码（验证后再设置），表单上就没有 passwordRequired -->
            <#if !(passwordRequired??)>${msg("acPrivacyRegisterVerifyFirst")}<br></#if>${msg("acPrivacyRegister")}
            <#else>${msg("acPrivacyReset1")}<br>${msg("acPrivacyReset2")}
            </#if>
          </p>
        </div>
        </#if>

        <div class="${properties.kcLoginMainFooter!} ac-footer-slot">
            <@loginFooter.content/>
        </div>
      </div>

      <div class="ac-form-bottom">
        <span>${msg("acCenterName")}</span>
        <#if acProduct?has_content && acReturnUrl?has_content>
        <a class="ac-back-product" href="${acReturnUrl}">${msg("acBackTo", acProduct)}<svg class="ac-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg></a>
        </#if>
      </div>
    </main>
  </div>
  <p class="ac-stage-footer">${msg("acStageFooter")}</p>
</div>
</body>
</html>
</#macro>
