# Echo

Chat em tempo real organizado em **rodas** (os grupos) e **canais** (os assuntos de cada roda).

O projeto tem três partes:

| Pasta | O que é |
|---|---|
| `server/` | Servidor Node.js: API REST em `/api`, gateway WebSocket em `/gateway` e banco SQLite. Também entrega a interface. |
| `web/` | A interface, em HTML, CSS e JavaScript puros (sem etapa de build). O servidor a publica em `/app`. |
| `desktop/` | Casca Electron: tela de abertura, janela que carrega a interface vinda do servidor e uma ponte estreita com o sistema. |

## Rodar

Precisa de Node.js 22.13 ou mais novo.

```bash
npm install
```

```bash
npm run seed
```

```bash
npm start
```

- `npm run seed` é opcional: cria três contas e uma conversa de demonstração. Os usuários e a senha estão em `scripts/seed.mjs`.
- `npm start` sobe o servidor e abre o aplicativo desktop. Na primeira vez o Electron baixa o próprio executável.
- Só o servidor: `npm run server`, e abra `http://127.0.0.1:3210/app` no navegador.
- Só o aplicativo: `npm run desktop`. Ele usa o endereço de servidor salvo nas preferências; se o endereço for desta máquina e não houver servidor no ar, o aplicativo sobe o servidor embutido.

## Gerar o instalador

```bash
npm run dist
```

Sai em `dist/Echo-Instalador-<versão>.exe`. Ele instala na conta do usuário (sem pedir administrador) e cria os atalhos.

- **Funciona sozinho.** O instalador leva o servidor e a interface junto. Ao abrir, o Echo sobe um servidor local embutido em `127.0.0.1:3210`, com o banco em `%APPDATA%\Echo\servidor`. Esse servidor só atende a própria máquina.
- **Para conversar com outras pessoas**, todas precisam apontar para o mesmo servidor: suba um com `npm run server` numa máquina acessível e informe o endereço em "Usar outro servidor" na tela de abertura.
- **Sem assinatura digital.** O Windows mostra o aviso do SmartScreen ("aplicativo não reconhecido") na instalação; assinar exige um certificado de assinatura de código.

## Hospedar para outras pessoas

Para gente em computadores diferentes conversar, todos precisam falar com o mesmo servidor, na internet e com HTTPS. Há dois caminhos.

### Vercel

A Vercel roda o `Dockerfile` da raiz como contêiner (ela escolhe esse modo sozinha ao importar o projeto):

1. Na Vercel, importe o repositório como projeto.
2. Em **Storage**, adicione um banco **Postgres** (por exemplo o Neon, no Marketplace) e conecte-o ao projeto. Isso define `DATABASE_URL` sozinho.
3. Publique de novo (**Redeploy**) para o servidor enxergar o banco.

Na Vercel não há disco permanente e podem existir várias instâncias do servidor ao mesmo tempo, então o Echo usa o Postgres no lugar do SQLite e faz as instâncias trocarem os avisos em tempo real pelo próprio banco (`LISTEN`/`NOTIFY`). O WebSocket da Vercel está em beta, e no plano gratuito cada conexão dura até 5 minutos; a interface reconecta sozinha.

### Servidor próprio ou contêiner

O mesmo `Dockerfile` serve em qualquer hospedagem de contêiner. Sem Postgres configurado, o banco é um arquivo SQLite:

- Ele escuta na porta `80` (ou na que vier em `PORT`) e guarda o banco em `/data`. **Monte um volume persistente em `/data`**, senão as contas e as conversas somem a cada reinício.
- A hospedagem precisa aceitar WebSocket e entregar HTTPS na frente do contêiner.
- Com o servidor no ar, qualquer pessoa usa o Echo pelo navegador, em `https://<seu-endereço>/app`, sem instalar nada. O aplicativo desktop aponta para o mesmo endereço em "Usar outro servidor".

## Verificar

```bash
npm test
```

```bash
npm run smoke
```

- `npm test` sobe o servidor numa porta livre e o exercita por HTTP e WebSocket, uma vez com SQLite e outra com Postgres (um Postgres embutido, o PGlite); também confere os canais de IPC da casca.
- `npm run smoke` abre o Electron de verdade (as janelas aparecem por alguns segundos), confere a ponte e o servidor embutido e deixa capturas em `.smoke/`. Com `ECHO_SMOKE_EXE=dist/win-unpacked/Echo.exe` ele verifica o aplicativo já empacotado.

## Configuração

| Variável | Padrão | Para quê |
|---|---|---|
| `ECHO_HOST` | `127.0.0.1` | Endereço em que o servidor escuta. Use `0.0.0.0` para aceitar a rede local. |
| `ECHO_PORT` | `3210` | Porta do servidor. |
| `ECHO_DATA_DIR` | `server/data` | Pasta do banco de dados. |
| `ECHO_SECURE_COOKIES` | desligado | Defina `1` quando o servidor estiver atrás de HTTPS. |
| `ECHO_DATABASE_URL` | — | Endereço de um Postgres; também aceita `DATABASE_URL` e `POSTGRES_URL`. Sem ele, o banco é o arquivo SQLite. |
| `ECHO_ICE_SERVERS` | STUN público | Lista JSON de servidores STUN/TURN usados nas chamadas. |
| `ECHO_TRUST_PROXY` | desligado | Defina `1` quando houver um proxy na frente, para o limite de tentativas valer por IP de quem acessa. |
| `ECHO_SERVER_URL` | — | Endereço que a casca desktop usa nesta execução, no lugar do salvo. |
| `ECHO_NO_LOCAL_SERVER` | desligado | Defina `1` para a casca nunca subir o servidor embutido. |

O servidor fala HTTP puro. Para usar fora da sua máquina, coloque-o atrás de um proxy com HTTPS: em HTTP as senhas e as conversas trafegam sem proteção.

## Como as peças conversam

- **Estado pela API, eventos pelo gateway.** A interface busca tudo em `GET /api/bootstrap` e depois só recebe eventos (`message_create`, `typing`, `presence`...). A cada reconexão ela busca o estado de novo.
- **Sessão em cookie `HttpOnly`.** O JavaScript da página nunca vê o token; no banco fica só o hash dele. Senhas passam por scrypt.
- **A casca não tem interface própria.** Ela carrega `<servidor>/app` numa janela isolada (sem Node, em sandbox) e expõe `window.EchoDesktop` pelo preload: avisos do sistema, indicador de não lidas, cores da janela e preferências. O processo principal só atende chamadas vindas da página do servidor configurado.

## Chamadas de voz, vídeo e tela

Cada roda pode ter canais de voz. Quem entra fala com os outros, pode ligar a câmera e compartilhar a tela.

- **A mídia vai direto de um navegador para o outro** (WebRTC), sem passar pelo servidor. O servidor só guarda quem está em cada chamada e repassa os sinais com que os navegadores combinam a conexão.
- **Limite de 8 pessoas por chamada.** Cada participante envia para todos os outros, então a qualidade cai conforme o grupo cresce; até uns 5 ou 6 costuma ir bem.
- **Redes muito fechadas podem não conectar.** O padrão usa só um servidor STUN público. Para cobrir essas redes, informe um servidor TURN em `ECHO_ICE_SERVERS` (uma lista JSON no formato de `iceServers` do WebRTC).
- **Reconexão não derruba a chamada.** Se a conexão com o servidor cair e voltar em até 12 segundos, a pessoa mantém o lugar; a conversa entre os navegadores nem é interrompida.

## O que ainda não tem

- Editar e apagar mensagens, mensagens diretas, anexos e busca.
- Nas chamadas: indicador de quem está falando, escolha de microfone/câmera e, no aplicativo desktop, escolha de qual janela compartilhar (hoje vai a tela inteira).
- Papéis e moderação: hoje só quem criou a roda abre canais, e não dá para sair de uma roda nem trocar o convite.
- Avisos do sistema no navegador (existem só no aplicativo desktop).
- Atualização automática e assinatura digital do aplicativo.
