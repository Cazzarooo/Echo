@echo off
rem Abre o Echo com dois cliques: sobe o servidor local e o aplicativo desktop.
rem Esta janela mostra o que o servidor registra; fechar o aplicativo encerra tudo.
cd /d "%~dp0"
if not exist node_modules call npm install
call npm start
