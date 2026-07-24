# -*- coding: utf-8 -*-
"""
Automacao SCODES - baixar o relatorio "Itens em Estoque"
=========================================================

O que este script faz, na ordem:
  1. Abre o SCODES e faz login (usuario + senha).
  2. Le a posicao que o cartao de seguranca pede e responde sozinho.
  3. Entra na tela "Relatorios > Itens em Estoque" clicando no menu
     (o SCODES bloqueia entrar por URL direta, entao clicamos no link).
  4. Marca TODAS as unidades dispensadoras.
  5. Clica em "Exportar Excel" e salva o arquivo na pasta de rede.

IMPORTANTE (seguranca): usuario, senha e cartao NAO ficam neste arquivo.
Eles ficam no arquivo ".env" (que nunca vai para o GitHub). Veja o
".env.example" ao lado para saber como preencher.

Como rodar:
  - Duplo clique em "2 - BAIXAR ESTOQUE.bat"
  - ou:  python baixar_estoque.py
"""

import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC


# ---------------------------------------------------------------------------
# 1) Configuracoes (lidas do arquivo .env, nunca escritas aqui no codigo)
# ---------------------------------------------------------------------------
PASTA = Path(__file__).resolve().parent
load_dotenv(PASTA / ".env")

BASE = "https://codes.saude.sp.gov.br"

USUARIO = os.getenv("SCODES_USUARIO", "").strip()
SENHA = os.getenv("SCODES_SENHA", "").strip()
CARTAO_RAW = os.getenv("SCODES_CARTAO", "").strip()
CAMINHO_REDE = os.getenv("SCODES_CAMINHO_REDE", "").strip()
HEADLESS = os.getenv("SCODES_HEADLESS", "0").strip() in ("1", "true", "True")

# Validacoes amigaveis (avisam claramente o que falta em vez de dar erro feio)
def _erro(msg):
    print("\n[ERRO] " + msg)
    print("Confira o arquivo .env (baseie-se no .env.example).\n")
    sys.exit(1)

if not USUARIO or not SENHA:
    _erro("Faltam SCODES_USUARIO e/ou SCODES_SENHA no .env.")
if not CAMINHO_REDE:
    _erro("Falta SCODES_CAMINHO_REDE (pasta onde salvar o Excel) no .env.")

# O cartao vem como 40 numeros separados por virgula (posicao 1 ate 40, em ordem)
valores_cartao = [v.strip() for v in CARTAO_RAW.split(",") if v.strip()]
if len(valores_cartao) != 40:
    _erro("O SCODES_CARTAO deve ter exatamente 40 numeros separados por "
          "virgula (posicao 1 a 40). Encontrei %d." % len(valores_cartao))
CARTAO = {i + 1: valores_cartao[i] for i in range(40)}

pasta_destino = Path(CAMINHO_REDE)
if not pasta_destino.is_dir():
    _erro("A pasta de rede nao esta acessivel agora:\n  %s\n"
          "Verifique se o drive G: esta conectado." % CAMINHO_REDE)


# ---------------------------------------------------------------------------
# 2) Preparar o navegador Chrome
# ---------------------------------------------------------------------------
def criar_navegador():
    opcoes = Options()
    if HEADLESS:
        opcoes.add_argument("--headless=new")
    opcoes.add_argument("--start-maximized")
    opcoes.add_argument("--disable-blink-features=AutomationControlled")
    # Fazer o Chrome baixar direto na pasta de rede, sem perguntar nada
    prefs = {
        "download.default_directory": str(pasta_destino),
        "download.prompt_for_download": False,
        "download.directory_upgrade": True,
        "safebrowsing.enabled": True,
    }
    opcoes.add_experimental_option("prefs", prefs)
    # Selenium 4.6+ ja baixa/gerencia o chromedriver sozinho (Selenium Manager)
    return webdriver.Chrome(options=opcoes)


def salvar_print(driver, nome):
    """Salva um print na subpasta logs/ para ajudar a diagnosticar erros."""
    try:
        (PASTA / "logs").mkdir(exist_ok=True)
        caminho = PASTA / "logs" / ("%s_%s.png" % (nome, datetime.now().strftime("%Y%m%d_%H%M%S")))
        driver.save_screenshot(str(caminho))
        print("   (print salvo em: %s)" % caminho)
    except Exception:
        pass


def dump_menu(driver, nome="menu_links"):
    """Salva TODOS os links da pagina atual (texto + href) para diagnostico."""
    try:
        (PASTA / "logs").mkdir(exist_ok=True)
        links = driver.execute_script(
            "return [...document.querySelectorAll('a')].map(a =>"
            " ({t:(a.textContent||'').trim().slice(0,60), h:a.getAttribute('href')}));"
        )
        caminho = PASTA / "logs" / ("%s_%s.txt" % (nome, datetime.now().strftime("%Y%m%d_%H%M%S")))
        with open(caminho, "w", encoding="utf-8") as f:
            f.write("URL atual: %s\n\n" % driver.current_url)
            for l in links:
                f.write("%-60s -> %s\n" % (l.get("t") or "", l.get("h")))
        print("   (menu salvo em: %s)" % caminho)
    except Exception:
        pass


def dump_html(driver, nome):
    """Salva o HTML da pagina atual para diagnostico."""
    try:
        (PASTA / "logs").mkdir(exist_ok=True)
        caminho = PASTA / "logs" / ("%s_%s.html" % (nome, datetime.now().strftime("%Y%m%d_%H%M%S")))
        with open(caminho, "w", encoding="utf-8") as f:
            f.write(driver.page_source)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 3) Etapas da automacao
# ---------------------------------------------------------------------------
def fazer_login(driver, wait):
    print("-> Abrindo o SCODES e fazendo login...")
    driver.get(BASE + "/LoginApp.aspx")
    wait.until(EC.presence_of_element_located(
        (By.ID, "ctl00_ContentPlaceHolder1_txtLogin"))).send_keys(USUARIO)
    driver.find_element(By.ID, "ctl00_ContentPlaceHolder1_txtSenha").send_keys(SENHA)
    driver.find_element(By.ID, "ctl00_ContentPlaceHolder1_btnEnviar").click()


def responder_cartao(driver, wait):
    print("-> Aguardando a tela do cartao de seguranca...")
    # Espera o campo do cartao aparecer. Se nao aparecer, provavelmente o
    # login falhou (usuario/senha errados) — avisamos de forma clara.
    try:
        campo = wait.until(EC.element_to_be_clickable(
            (By.ID, "ctl00_ContentPlaceHolder1_txtNumero")))
    except Exception:
        salvar_print(driver, "erro_login")
        _erro("Nao chegou na tela do cartao. Verifique usuario/senha no .env "
              "(ou o SCODES pode estar fora do ar).")

    # Le o texto "Posicao: N" da tela
    texto = driver.find_element(By.TAG_NAME, "body").text
    m = re.search(r"Posi[cç][aã]o:\s*(\d+)", texto, re.IGNORECASE)
    if not m:
        salvar_print(driver, "erro_posicao")
        _erro("Nao consegui identificar a posicao pedida do cartao na tela.")

    posicao = int(m.group(1))
    valor = CARTAO.get(posicao)
    if not valor:
        _erro("O SCODES pediu a posicao %d, que nao existe no cartao do .env." % posicao)

    print("   Posicao pedida: %d (respondendo...)" % posicao)
    campo.send_keys(valor)
    driver.find_element(By.ID, "ctl00_ContentPlaceHolder1_btnValidarCartao").click()


def _achar_link_relatorio(driver):
    """Procura o link <a href=...RelItensEmEstoque...> na pagina atual."""
    alvos = driver.find_elements(By.CSS_SELECTOR, "a[href*='RelItensEmEstoque']")
    return alvos[0] if alvos else None


def _hover(driver, elemento):
    """Passa o mouse sobre um elemento (para abrir menus suspensos)."""
    ActionChains(driver).move_to_element(elemento).perform()
    time.sleep(1.0)


def _abrir_menu_ate_o_link(driver):
    """Abre a cadeia de menus Relatorio > Estoque e devolve o link do
    relatorio 'Itens em Estoque' (ou None se nao conseguir)."""
    # Nivel 1: passar o mouse no menu de topo "Relatorio(s)"
    tops = driver.find_elements(
        By.XPATH,
        "//a[starts-with(normalize-space(.), 'Relat') or "
        "starts-with(normalize-space(.), 'RELAT')]")
    for topo in tops:
        try:
            _hover(driver, topo)
        except Exception:
            continue

        # As vezes so o hover no topo ja coloca o link no DOM
        link = _achar_link_relatorio(driver)
        if link is not None:
            return link

        # Nivel 2: passar o mouse no subitem "Estoque" (o que abre o submenu,
        # e nao um dos itens-folha como "Falta Estoque"/"Movimentacao Estoque")
        estoques = driver.find_elements(
            By.XPATH, "//*[normalize-space(.)='Estoque' or normalize-space(.)='ESTOQUE']")
        for est in estoques:
            try:
                _hover(driver, est)
            except Exception:
                continue
            link = _achar_link_relatorio(driver)
            if link is not None:
                return link

        # Ultima tentativa deste topo: passar o mouse em QUALQUER item que
        # contenha "Estoque" no texto (cobre rotulos diferentes)
        outros = driver.find_elements(
            By.XPATH, "//a[contains(translate(., 'ESTOQUE', 'estoque'), 'estoque')]")
        for o in outros:
            try:
                _hover(driver, o)
            except Exception:
                continue
            link = _achar_link_relatorio(driver)
            if link is not None:
                return link

    return None


def ir_para_relatorio(driver, wait):
    print("-> Entrando em Relatorios > Itens em Estoque...")

    # Espera a pagina pos-cartao (landing) carregar: o menu de topo com
    # "Relatorios" precisa existir.
    try:
        WebDriverWait(driver, 20).until(EC.presence_of_element_located(
            (By.XPATH, "//a[contains(normalize-space(.), 'Relat')]")))
    except Exception:
        pass
    time.sleep(1)

    # Diagnostico: guarda todos os links do menu desta tela (ajuda se falhar)
    dump_menu(driver, "menu_apos_cartao")

    # O SCODES bloqueia URL direta (InvalidAccess). A unica forma que funciona
    # e CLICAR no link do menu (ele envia o Referer correto).
    # O caminho tem TRES niveis:  Relatorio > Estoque > Itens em Estoque.
    # Entao precisamos passar o mouse em "Relatorio" e depois em "Estoque"
    # para o link "Itens em Estoque" aparecer.
    link = _achar_link_relatorio(driver)

    if link is None:
        link = _abrir_menu_ate_o_link(driver)

    if link is not None:
        # Clique via JavaScript no link real: navega com o Referer correto,
        # o que evita o redirecionamento para InvalidAccess.aspx.
        driver.execute_script("arguments[0].click();", link)
    else:
        # Ultimo recurso: navegar direto, mas forcando o cabecalho Referer
        # via Chrome DevTools (pode enganar a checagem do InvalidAccess).
        print("   (link do menu nao encontrado; tentando com Referer forcado)")
        try:
            driver.execute_cdp_cmd("Network.enable", {})
            driver.execute_cdp_cmd("Network.setExtraHTTPHeaders", {
                "headers": {"Referer": driver.current_url,
                            "Sec-Fetch-Site": "same-origin"}})
        except Exception:
            pass
        driver.get(BASE + "/RelItensEmEstoque.aspx")

    # Confirma que chegamos na tela do relatorio (o botao de exportar existe la)
    try:
        wait.until(EC.presence_of_element_located(
            (By.ID, "ctl00_ContentPlaceHolder1_btnVisualizarXls")))
    except Exception:
        salvar_print(driver, "erro_tela_relatorio")
        dump_html(driver, "pagina_relatorio_falhou")
        _erro("Nao consegui abrir a tela do relatorio 'Itens em Estoque'. "
              "Veja o arquivo 'menu_apos_cartao_*.txt' na pasta logs.")


def marcar_todas_unidades(driver):
    print("-> Marcando TODAS as unidades dispensadoras...")
    # As unidades vem desmarcadas. Marcamos cada checkbox 'ddlUD_*' que
    # estiver desmarcado. Fazer via JS de uma vez e rapido e evita problemas
    # de rolagem/elemento fora da tela.
    marcadas = driver.execute_script(
        """
        var cbs = document.querySelectorAll(
            "input[id^='ctl00_ContentPlaceHolder1_ddlUD_']");
        var n = 0;
        cbs.forEach(function(cb){ if(!cb.checked){ cb.click(); n++; } });
        return [cbs.length, n];
        """
    )
    print("   Unidades no total: %d | marcadas agora: %d" % (marcadas[0], marcadas[1]))
    if marcadas[0] == 0:
        print("   [AVISO] Nenhuma unidade encontrada na tela — confira o layout.")


def exportar_excel(driver, wait):
    print("-> Exportando para Excel e aguardando o download...")
    antes = set(os.listdir(pasta_destino))
    driver.find_element(By.ID, "ctl00_ContentPlaceHolder1_btnVisualizarXls").click()

    # Espera o arquivo terminar de baixar (some o .crdownload e surge um novo arquivo)
    novo = esperar_download(antes, timeout=180)
    if not novo:
        salvar_print(driver, "erro_download")
        _erro("O download nao terminou no tempo esperado. Confira a pasta de rede.")

    # Renomeia com a data de hoje para nao sobrescrever downloads anteriores.
    # (O importador do sistema le a data da ABA interna do arquivo, entao
    #  renomear o arquivo NAO atrapalha a importacao.)
    origem = pasta_destino / novo
    hoje = datetime.now().strftime("%d%m%Y")
    destino = pasta_destino / ("Rel_ItensEmEstoque_%s%s" % (hoje, origem.suffix))
    try:
        if destino.exists():
            destino = pasta_destino / ("Rel_ItensEmEstoque_%s_%s%s" % (
                hoje, datetime.now().strftime("%H%M%S"), origem.suffix))
        origem.rename(destino)
        final = destino
    except Exception:
        final = origem  # se nao der para renomear, fica com o nome original

    print("\n[OK] Relatorio salvo em:\n  %s\n" % final)


def esperar_download(antes, timeout=180):
    """Espera aparecer um arquivo novo e finalizado na pasta de destino."""
    fim = time.time() + timeout
    while time.time() < fim:
        atual = set(os.listdir(pasta_destino))
        novos = [f for f in (atual - antes)]
        baixando = [f for f in atual if f.endswith(".crdownload")]
        # ha arquivo novo e nenhum download em andamento
        finalizados = [f for f in novos if not f.endswith(".crdownload")]
        if finalizados and not baixando:
            # devolve o mais recente
            finalizados.sort(key=lambda f: (pasta_destino / f).stat().st_mtime)
            return finalizados[-1]
        time.sleep(1)
    return None


# ---------------------------------------------------------------------------
# 4) Fluxo principal
# ---------------------------------------------------------------------------
def main():
    print("=" * 60)
    print(" Automacao SCODES - Itens em Estoque")
    print(" Destino: %s" % CAMINHO_REDE)
    print("=" * 60)

    driver = criar_navegador()
    wait = WebDriverWait(driver, 30)
    try:
        fazer_login(driver, wait)
        responder_cartao(driver, wait)
        ir_para_relatorio(driver, wait)
        marcar_todas_unidades(driver)
        exportar_excel(driver, wait)
        print("Concluido com sucesso!")
    except SystemExit:
        raise  # erros ja tratados por _erro()
    except Exception as e:
        print("\n[ERRO inesperado] %s" % e)
        salvar_print(driver, "erro_geral")
    finally:
        # Pequena pausa para garantir que o download foi flushado, e fecha.
        time.sleep(2)
        driver.quit()


if __name__ == "__main__":
    main()
