package com.zzz0418c.autotransformation;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final String TAG = "AutoTransformation";
    private static final String PREFS = "settings";
    private static final String KEY_SERVER = "server_url";
    private static final String DEFAULT_SERVER = "http://127.0.0.1:8787";
    private static final int REQUEST_FILE = 1001;

    private static final int PAPER = Color.parseColor("#f7f3ea");
    private static final int INK = Color.parseColor("#221f1a");
    private static final int MUTED = Color.parseColor("#7a7062");
    private static final int LINE = Color.parseColor("#e3dac9");
    private static final int ACCENT = Color.parseColor("#8d2f38");

    private WebView webView;
    private ProgressBar progressBar;
    private ValueCallback<Uri[]> fileCallback;
    private String serverUrl;
    private boolean errorDialogShown;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(PAPER);
        window.setNavigationBarColor(PAPER);
        int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        window.getDecorView().setSystemUiVisibility(flags);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        serverUrl = prefs.getString(KEY_SERVER, DEFAULT_SERVER);

        buildLayout();
        configureWebView();
        loadServer();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private TextView actionButton(String label, View.OnClickListener listener) {
        TextView button = new TextView(this);
        button.setText(label);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        button.setTextColor(ACCENT);
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(14), 0, dp(14), 0);
        button.setMinHeight(dp(44));
        button.setClickable(true);
        button.setFocusable(true);

        TypedValue outValue = new TypedValue();
        if (getTheme().resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, outValue, true)) {
            button.setBackgroundResource(outValue.resourceId);
        }
        button.setOnClickListener(listener);
        return button;
    }

    private void buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(PAPER);

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(20), 0, dp(8), 0);
        header.setBackgroundColor(PAPER);

        TextView title = new TextView(this);
        title.setText("AutoTransformation");
        title.setTextColor(INK);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        title.setTypeface(Typeface.SERIF, Typeface.BOLD);
        header.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(actionButton("刷新", v -> loadServer()));
        header.addView(actionButton("服务器", v -> showServerDialog()));
        header.addView(actionButton("电子书", v -> openEbooks()));

        root.addView(header, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)));

        View divider = new View(this);
        divider.setBackgroundColor(LINE);
        root.addView(divider, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgressTintList(ColorStateList.valueOf(ACCENT));
        progressBar.setVisibility(View.GONE);
        root.addView(progressBar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));

        webView = new WebView(this);
        webView.setBackgroundColor(PAPER);
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setUserAgentString(settings.getUserAgentString() + " AutoTransformationTablet/1.0");

        WebView.setWebContentsDebuggingEnabled(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;

                String scheme = uri.getScheme();
                if (!"http".equals(scheme) && !"https".equals(scheme)) {
                    openExternally(uri);
                    return true;
                }

                String host = uri.getHost();
                String serverHost = Uri.parse(serverUrl).getHost();
                if (host != null && (host.equals("127.0.0.1") || host.equals("localhost") || host.equals(serverHost))) {
                    return false;
                }

                openExternally(uri);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                errorDialogShown = false;
                progressBar.setVisibility(View.VISIBLE);
                progressBar.setProgress(0);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                view.evaluateJavascript(
                    "(function(){var t=document.querySelector('.topbar');if(t){t.style.display='none';}document.body.style.paddingTop='0';})();",
                    null
                );
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    progressBar.setVisibility(View.GONE);
                    showConnectionError();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             WebChromeClient.FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/*");
                intent.putExtra(
                    Intent.EXTRA_ALLOW_MULTIPLE,
                    params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
                );
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                try {
                    startActivityForResult(Intent.createChooser(intent, "选择书页照片"), REQUEST_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "找不到图片选择器", Toast.LENGTH_LONG).show();
                    return false;
                }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                Log.d(TAG, consoleMessage.message() + " @" + consoleMessage.lineNumber());
                return true;
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception e) {
                Toast.makeText(this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            Toast.makeText(this, "没有可打开该链接的应用", Toast.LENGTH_SHORT).show();
        }
    }

    private void loadServer() {
        errorDialogShown = false;
        progressBar.setVisibility(View.VISIBLE);
        progressBar.setProgress(0);
        webView.loadUrl(serverUrl);
    }

    private void openEbooks() {
        if (webView == null) return;
        webView.evaluateJavascript(
            "window.openEbooks ? window.openEbooks() : null",
            null
        );
    }

    private String normalizeServerUrl(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return null;

        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            value = "http://" + value;
        }
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }

        Uri uri = Uri.parse(value);
        if (uri.getHost() == null) return null;
        return value;
    }

    private void showServerDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(8), dp(24), 0);

        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(serverUrl);
        input.setSelection(input.getText().length());
        box.addView(input, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        TextView hint = new TextView(this);
        hint.setText("USB 调试：先在电脑执行\nadb reverse tcp:8787 tcp:8787\n然后填 http://127.0.0.1:8787\n\nWi-Fi：填电脑局域网 IP，电脑端 HOST=0.0.0.0");
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        hint.setTextColor(MUTED);
        hint.setPadding(0, dp(10), 0, 0);
        box.addView(hint);

        new AlertDialog.Builder(this)
            .setTitle("服务器地址")
            .setView(box)
            .setPositiveButton("保存并加载", (dialog, which) -> {
                String value = normalizeServerUrl(input.getText().toString());
                if (value == null) {
                    Toast.makeText(this, "地址格式不对，例如 http://192.168.1.20:8787", Toast.LENGTH_LONG).show();
                    return;
                }
                serverUrl = value;
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, value).apply();
                loadServer();
            })
            .setNegativeButton("取消", null)
            .show();
    }

    private void showConnectionError() {
        if (errorDialogShown) return;
        errorDialogShown = true;

        new AlertDialog.Builder(this)
            .setTitle("连不上本地服务")
            .setMessage("请确认：\n\n1. 电脑上的 npm start 正在运行\n2. USB 调试已执行 adb reverse tcp:8787 tcp:8787\n3. 或在「服务器」里填电脑的局域网地址")
            .setPositiveButton("设置地址", (dialog, which) -> showServerDialog())
            .setNegativeButton("重试", (dialog, which) -> loadServer())
            .show();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FILE || fileCallback == null) return;

        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }

        fileCallback.onReceiveValue(results);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
