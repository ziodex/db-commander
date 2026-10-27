// Windows' SQL client owns SSPI, Kerberos/NTLM and TLS certificate validation.
// One private process owns one connection; credentials never cross this pipe.
using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Data.SqlTypes;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class WindowsSqlServer
{
    public sealed class Configuration
    {
        public string Host { get; set; }
        public int Port { get; set; }
        public string Database { get; set; }
        public bool Encrypt { get; set; }
    }
    public sealed class Parameter
    {
        public string Value { get; set; }
        public bool Binary { get; set; }
    }
    public sealed class Message
    {
        public string Action { get; set; }
        public string Sql { get; set; }
        public Parameter[] Parameters { get; set; }
        public string Prefix { get; set; }
        public int Timeout { get; set; }
        public bool Procedure { get; set; }
    }

    private static readonly object OutputLock = new object(), CommandLock = new object();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
    private static SqlConnection connection;
    private static SqlCommand active;
    private static volatile bool cancelled;

    private static void Send(object value)
    {
        lock (OutputLock) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    }

    private static string Cell(SqlDataReader reader, int index)
    {
        if (reader.IsDBNull(index)) return null;
        string type = reader.GetDataTypeName(index).ToLowerInvariant();
        if (type == "date") return reader.GetDateTime(index).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (type == "datetime" || type == "datetime2" || type == "smalldatetime")
            return reader.GetDateTime(index).ToString("yyyy-MM-dd HH:mm:ss.fffffff", CultureInfo.InvariantCulture);
        if (type == "datetimeoffset") return reader.GetDateTimeOffset(index).ToString("yyyy-MM-dd HH:mm:ss.fffffffzzz", CultureInfo.InvariantCulture);
        if (type == "time") return reader.GetTimeSpan(index).ToString(@"hh\:mm\:ss\.fffffff", CultureInfo.InvariantCulture);
        object value = reader.GetSqlValue(index);
        if (value is SqlBinary) return "0x" + BitConverter.ToString(((SqlBinary)value).Value).Replace("-", "").ToLowerInvariant();
        if (value is SqlBoolean) return ((SqlBoolean)value).Value ? "1" : "0";
        if (value is SqlDouble) return ((SqlDouble)value).Value.ToString("R", CultureInfo.InvariantCulture);
        if (value is SqlSingle) return ((SqlSingle)value).Value.ToString("R", CultureInfo.InvariantCulture);
        if (value is SqlXml) return ((SqlXml)value).Value;
        // SqlDecimal retains all 38 digits; converting it to System.Decimal loses precision.
        return Convert.ToString(value, CultureInfo.InvariantCulture);
    }

    private static void Query(SqlCommand command)
    {
        try
        {
            command.StatementCompleted += delegate(object sender, StatementCompletedEventArgs args) { Send(new { kind = "done", count = args.RecordCount }); };
            using (SqlDataReader reader = command.ExecuteReader())
            {
                do
                {
                    if (reader.FieldCount == 0) continue;
                    var columns = new List<object>();
                    for (int i = 0; i < reader.FieldCount; i++) columns.Add(new { name = reader.GetName(i), typeId = 0, typeName = reader.GetDataTypeName(i) });
                    Send(new { kind = "fields", columns = columns });
                    while (reader.Read())
                    {
                        var row = new string[reader.FieldCount];
                        for (int i = 0; i < row.Length; i++) row[i] = Cell(reader, i);
                        Send(new { kind = "row", row = row });
                    }
                } while (reader.NextResult());
            }
        }
        catch (Exception error)
        {
            var sqlError = error as SqlException;
            string code = cancelled ? "ECANCEL" : sqlError != null && sqlError.Class < 20 && sqlError.Number != 0 ? "EREQUEST" : "ECONNCLOSED";
            Send(new { kind = "error", message = error.Message, code = code });
        }
        finally
        {
            if (connection.State == ConnectionState.Open) Send(new { kind = "database", database = connection.Database });
            lock (CommandLock) { active = null; command.Dispose(); }
            Send(new { kind = "complete" });
        }
    }

    private static void Main()
    {
        Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;
        Thread.CurrentThread.CurrentUICulture = CultureInfo.InvariantCulture;
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            string first = Console.ReadLine();
            if (first == null) return;
            Configuration config = Json.Deserialize<Configuration>(first);
            var builder = new SqlConnectionStringBuilder {
                DataSource = "tcp:" + config.Host + "," + config.Port,
                InitialCatalog = config.Database ?? "", IntegratedSecurity = true,
                Encrypt = config.Encrypt, TrustServerCertificate = false,
                ConnectTimeout = 15, ConnectRetryCount = 0, Pooling = false, Enlist = false,
                ApplicationName = "Db Commander", PersistSecurityInfo = false
            };
            using (connection = new SqlConnection(builder.ConnectionString))
            {
                connection.InfoMessage += delegate(object sender, SqlInfoMessageEventArgs args) { Send(new { kind = "notice", message = args.Message }); };
                connection.Open();
                Send(new { kind = "ready", user = System.Security.Principal.WindowsIdentity.GetCurrent().Name });
                string line;
                while ((line = Console.ReadLine()) != null)
                {
                    Message message = Json.Deserialize<Message>(line);
                    lock (CommandLock)
                    {
                        if (message.Action == "cancel") { cancelled = true; if (active != null) active.Cancel(); continue; }
                        if (message.Action != "query" || active != null) throw new InvalidOperationException("A query is already running or the request is invalid.");
                        cancelled = false;
                        var command = connection.CreateCommand();
                        command.CommandText = message.Sql; command.CommandTimeout = message.Timeout;
                        if (message.Procedure) command.CommandType = CommandType.StoredProcedure;
                        for (int i = 0; i < (message.Parameters ?? new Parameter[0]).Length; i++)
                        {
                            Parameter parameter = message.Parameters[i];
                            var value = command.Parameters.Add("@" + message.Prefix + (i + 1), parameter.Binary ? SqlDbType.VarBinary : SqlDbType.NVarChar, -1);
                            value.Value = parameter.Value == null ? (object)DBNull.Value : parameter.Binary ? (object)Convert.FromBase64String(parameter.Value) : parameter.Value;
                        }
                        active = command;
                        var thread = new Thread(delegate() { Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture; Query(command); });
                        thread.IsBackground = true; thread.Start();
                    }
                }
                // EOF means the database host exited. Do not leave a SQL session behind.
                lock (CommandLock) { if (active != null) active.Cancel(); }
            }
        }
        catch (Exception error)
        {
            var sqlError = error as SqlException;
            Send(new { kind = "error", message = error.Message, code = sqlError != null && sqlError.Number == 18456 ? "ELOGIN" : "ECONNCLOSED" });
            Environment.ExitCode = 1;
        }
    }
}
